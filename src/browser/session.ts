// A sessão de navegador: abrir, reaproveitar, registrar abas e fechar na hora.
//
// Três decisões moldam este arquivo, e todas vêm da mesma restrição — o
// Browser Rendering cobra por tempo de navegador aberto e só aceita UMA
// conexão de Worker por sessão:
//
//   1. Conectar e desconectar a cada chamada de ferramenta. Segurar a conexão
//      entre chamadas travaria a sessão para qualquer outra e não sobreviveria
//      ao Durable Object ser descartado. O que sobrevive é o `sessionId`, que
//      fica no storage do DO e permite reconectar no mesmo Chromium.
//
//   2. Nada de ElementHandle guardado entre chamadas. O que atravessa é o
//      `targetId` da aba (id do CDP, estável) e o snapshot posicional
//      (src/browser/snapshot.ts).
//
//   3. Todo código que roda DENTRO da página é string, nunca callback tipado.
//      O tsconfig do Worker não carrega a lib DOM — ela conflita com os tipos
//      do Workers — então `page.evaluate(el => el.value)` nem compilaria. As
//      ferramentas de alto nível do puppeteer (click/type/select/hover) não
//      precisam de callback, e é por elas que passamos.

import puppeteer from '@cloudflare/puppeteer';
import type { Browser, ElementHandle, Page, WorkersLaunchOptions } from '@cloudflare/puppeteer';

import type { Config } from '../config.ts';
import type {
  CollectorDrain,
  ConsoleEntry,
  DialogEntry,
  Env,
  NetworkEntry,
  PageRecord,
  StoredSnapshot,
} from '../types.ts';
import { BudgetExceededError, BudgetLedger } from './budget.ts';
import { BrowserToolError } from './errors.ts';
import { COLLECTOR_DRAIN_SOURCE, collectorInstallSource } from './collector.ts';
import {
  type AxLike,
  DEFAULT_MAX_NODES,
  entriesOf,
  flatten,
  makeUid,
  parseUid,
  renderSnapshot,
  stillMatches,
} from './snapshot.ts';

/** Quantas entradas de cada tipo o storage do DO guarda por aba. */
const CONSOLE_KEEP = 150;
const NETWORK_KEEP = 200;
const DIALOG_KEEP = 50;
/** Texto truncado antes de persistir — o storage do DO tem 128 KiB por chave. */
const STORED_TEXT_MAX = 500;

const K = {
  sessionId: 'cdp:sessionId',
  pages: 'cdp:pages',
  selected: 'cdp:selected',
  seq: 'cdp:seq',
  nextPage: 'cdp:nextPage',
  console: (pageId: string) => `cdp:console:${pageId}`,
  network: (pageId: string) => `cdp:network:${pageId}`,
  dialogs: (pageId: string) => `cdp:dialogs:${pageId}`,
  snapshot: (pageId: string) => `cdp:snapshot:${pageId}`,
};

export interface PageInfo {
  id: string;
  url: string;
  title: string;
  selected: boolean;
}

function clip(text: string, size = STORED_TEXT_MAX): string {
  return text.length > size ? `${text.slice(0, size)}…` : text;
}

/**
 * Id da aba no CDP. `_targetId` é o caminho barato (já está em memória); o
 * fallback pelo protocolo existe porque esse campo é interno do puppeteer e
 * pode sumir numa atualização — aí pagamos um round-trip em vez de quebrar.
 */
async function targetIdOf(page: Page): Promise<string> {
  const target = page.target() as unknown as { _targetId?: unknown };
  if (typeof target._targetId === 'string' && target._targetId) return target._targetId;

  const cdp = await page.createCDPSession();
  try {
    const info = await cdp.send('Target.getTargetInfo');
    return info.targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Handle vivo de uma sessão: só existe dentro de `BrowserSession.run()`,
 * enquanto a conexão com o Chromium está aberta.
 */
export class SessionHandle {
  constructor(
    readonly browser: Browser,
    private storage: DurableObjectStorage,
    private config: Config,
    private records: PageRecord[],
    private byTarget: Map<string, Page>,
    private selectedId: string | null
  ) {}

  /** true quando a sessão foi criada agora (útil para avisar sobre custo). */
  launchedNow = false;

  get sessionId(): string {
    return this.browser.sessionId();
  }

  async listPages(): Promise<PageInfo[]> {
    const infos: PageInfo[] = [];
    for (const record of this.records) {
      const page = this.byTarget.get(record.targetId);
      if (!page) continue;
      infos.push({
        id: record.id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        selected: record.id === this.selectedId,
      });
    }
    return infos;
  }

  /**
   * Resolve o id que o modelo mandou. Sem id, usa a aba selecionada; sem
   * nenhuma aba, cria uma em branco — assim a primeira chamada de qualquer
   * ferramenta funciona sem o modelo precisar chamar new_page antes.
   */
  async page(pageId?: string): Promise<{ id: string; page: Page }> {
    if (pageId) {
      const record = this.records.find((r) => r.id === pageId);
      const page = record && this.byTarget.get(record.targetId);
      if (!record || !page) {
        const known = this.records.map((r) => r.id).join(', ') || 'nenhuma';
        throw new BrowserToolError(
          `Aba "${pageId}" não existe. Abas abertas: ${known}. Use list_pages.`
        );
      }
      return { id: record.id, page };
    }

    if (this.selectedId) {
      const record = this.records.find((r) => r.id === this.selectedId);
      const page = record && this.byTarget.get(record.targetId);
      if (record && page) return { id: record.id, page };
    }

    const first = this.records[0];
    const firstPage = first && this.byTarget.get(first.targetId);
    if (first && firstPage) {
      await this.select(first.id);
      return { id: first.id, page: firstPage };
    }

    return this.newPage();
  }

  async newPage(url?: string): Promise<{ id: string; page: Page }> {
    if (this.records.length >= this.config.maxPages) {
      throw new BrowserToolError(
        `Limite de ${this.config.maxPages} aba(s) simultâneas atingido. ` +
          `Feche uma com close_page, ou aumente BROWSER_MAX_PAGES no wrangler.jsonc. ` +
          `O limite existe porque cada aba consome memória do mesmo Chromium — ` +
          `abas demais derrubam a sessão inteira.`
      );
    }

    const page = await this.browser.newPage();
    const targetId = await targetIdOf(page);
    const id = await this.nextPageId();
    this.records.push({ id, targetId });
    this.byTarget.set(targetId, page);
    await this.storage.put(K.pages, this.records);
    await this.select(id);

    // O coletor entra ANTES da navegação: assim o console e a rede da primeira
    // carga já são capturados, que é justamente o que interessa depurar.
    await this.ensureCollector(page);
    if (url) await this.goto(page, url);
    return { id, page };
  }

  async closePage(pageId: string): Promise<void> {
    const record = this.records.find((r) => r.id === pageId);
    const page = record && this.byTarget.get(record.targetId);
    if (!record || !page) throw new BrowserToolError(`Aba "${pageId}" não existe.`);

    await page.close().catch(() => {});
    this.records = this.records.filter((r) => r.id !== pageId);
    this.byTarget.delete(record.targetId);
    await this.storage.put(K.pages, this.records);
    await this.storage.delete([
      K.console(pageId),
      K.network(pageId),
      K.dialogs(pageId),
      K.snapshot(pageId),
    ]);
    if (this.selectedId === pageId) {
      const next = this.records[0]?.id ?? null;
      this.selectedId = next;
      if (next) await this.storage.put(K.selected, next);
      else await this.storage.delete(K.selected);
    }
  }

  async select(pageId: string): Promise<void> {
    this.selectedId = pageId;
    await this.storage.put(K.selected, pageId);
  }

  /** Navega com o timeout configurado e traduz o erro mais comum. */
  async goto(page: Page, url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'): Promise<void> {
    let normalized: string;
    try {
      normalized = new URL(url).toString();
    } catch {
      throw new BrowserToolError(
        `URL inválida: "${url}". Inclua o esquema (https://...).`
      );
    }
    try {
      await page.goto(normalized, {
        timeout: this.config.timeoutMs,
        waitUntil: waitUntil ?? 'load',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/blocked|guardrail|ERR_BLOCKED/i.test(message) && this.config.allowedDomains.length) {
        throw new BrowserToolError(
          `Navegação para ${normalized} bloqueada pela lista de domínios ` +
            `permitidos (BROWSER_ALLOWED_DOMAINS = ${this.config.allowedDomains.join(', ')}). ` +
            `A trava é aplicada pela Cloudflare na criação da sessão e não pode ` +
            `ser afrouxada sem reiniciar a sessão.`
        );
      }
      throw new BrowserToolError(`Falha ao navegar para ${normalized}: ${message}`);
    }
  }

  // ------------------------------------------------------------- coletor

  async ensureCollector(page: Page): Promise<void> {
    const source = collectorInstallSource(this.config.dialogDefault);
    const present = await page
      .evaluate('typeof window.__mcpCollector !== "undefined"')
      .catch(() => false);
    if (present === true) return;

    // Registrar primeiro para as próximas navegações, injetar depois no
    // documento atual. O script sai na primeira linha se já estiver instalado,
    // então rodar duas vezes não duplica nada.
    await page.evaluateOnNewDocument(source).catch(() => {});
    await page.evaluate(source).catch(() => {});
  }

  /**
   * Puxa o que a página acumulou desde a última chamada e guarda no storage do
   * DO. Rodar isso a cada ferramenta é o que faz o histórico sobreviver às
   * navegações: o buffer da página some quando o documento troca, o do DO não.
   */
  async drain(pageId: string, page: Page): Promise<void> {
    const drained = (await page
      .evaluate(COLLECTOR_DRAIN_SOURCE)
      .catch(() => null)) as CollectorDrain | null;

    if (!drained) {
      await this.ensureCollector(page);
      return;
    }

    if (drained.console?.length) {
      await this.append<ConsoleEntry>(
        K.console(pageId),
        drained.console.map((entry) => ({ ...entry, text: clip(entry.text) })),
        CONSOLE_KEEP
      );
    }
    if (drained.network?.length) {
      await this.append<NetworkEntry>(K.network(pageId), drained.network, NETWORK_KEEP);
    }
    if (drained.dialogs?.length) {
      await this.append<DialogEntry>(K.dialogs(pageId), drained.dialogs, DIALOG_KEEP);
    }
  }

  private async append<T>(key: string, incoming: T[], keep: number): Promise<void> {
    const existing = (await this.storage.get<T[]>(key)) ?? [];
    const merged = existing.concat(incoming);
    await this.storage.put(key, merged.slice(Math.max(0, merged.length - keep)));
  }

  async consoleEntries(pageId: string): Promise<ConsoleEntry[]> {
    return (await this.storage.get<ConsoleEntry[]>(K.console(pageId))) ?? [];
  }

  async networkEntries(pageId: string): Promise<NetworkEntry[]> {
    return (await this.storage.get<NetworkEntry[]>(K.network(pageId))) ?? [];
  }

  async dialogEntries(pageId: string): Promise<DialogEntry[]> {
    return (await this.storage.get<DialogEntry[]>(K.dialogs(pageId))) ?? [];
  }

  async clearBuffers(pageId: string): Promise<void> {
    await this.storage.delete([K.console(pageId), K.network(pageId), K.dialogs(pageId)]);
  }

  // ------------------------------------------------------------ snapshot

  async takeSnapshot(
    pageId: string,
    page: Page,
    options: { verbose?: boolean; maxNodes?: number } = {}
  ): Promise<string> {
    const verbose = options.verbose === true;
    const root = (await page.accessibility.snapshot({
      interestingOnly: !verbose,
    })) as AxLike | null;

    const result = flatten(root, options.maxNodes ?? DEFAULT_MAX_NODES);
    const seq = ((await this.storage.get<number>(K.seq)) ?? 0) + 1;
    await this.storage.put(K.seq, seq);
    const snapshot: StoredSnapshot = {
      seq,
      entries: entriesOf(result.nodes),
      verbose,
      takenAt: Date.now(),
    };
    await this.storage.put(K.snapshot(pageId), snapshot);

    const header =
      `# ${pageId} — ${page.url()}\n` +
      `# ${result.nodes.length} nó(s). Use o uid nas ferramentas de interação; ` +
      `ele vale só até a página mudar.`;
    return renderSnapshot(seq, result, header);
  }

  /**
   * Traduz um uid de volta para um elemento vivo. Refaz o snapshot e confere
   * que o nó daquele índice ainda tem o mesmo papel e nome — é isso que impede
   * um clique no lugar errado depois que a página mexeu sozinha.
   */
  async resolveUid(pageId: string, page: Page, uid: string): Promise<ElementHandle> {
    const parsed = parseUid(uid);
    if (!parsed) {
      throw new BrowserToolError(
        `uid inválido: "${uid}". O formato é <snapshot>_<índice>, como "1_42", ` +
          `e vem do take_snapshot.`
      );
    }

    const stored = await this.storage.get<StoredSnapshot>(K.snapshot(pageId));
    if (!stored) {
      throw new BrowserToolError(
        `Nenhum snapshot da aba ${pageId} nesta sessão. Rode take_snapshot antes.`
      );
    }
    if (stored.seq !== parsed.seq) {
      throw new BrowserToolError(
        `O uid "${uid}" é do snapshot ${parsed.seq}, e o atual da aba ${pageId} ` +
          `é o ${stored.seq}. Rode take_snapshot de novo e use os uids novos.`
      );
    }

    const root = (await page.accessibility.snapshot({
      interestingOnly: !stored.verbose,
    })) as AxLike | null;
    const { nodes } = flatten(root, Math.max(stored.entries.length, DEFAULT_MAX_NODES));
    const target = nodes[parsed.index];
    const expected = stored.entries[parsed.index];

    if (!target || !stillMatches(expected, target.node)) {
      const found = target ? `${target.node.role} ${JSON.stringify(target.node.name ?? '')}` : 'nada';
      throw new BrowserToolError(
        `A página mudou desde o snapshot ${stored.seq}: no índice ${parsed.index} ` +
          `esperava ${expected ? `${expected.role} ${JSON.stringify(expected.name)}` : 'um nó'}` +
          ` e encontrei ${found}. Rode take_snapshot de novo.`
      );
    }

    const handle = await (target.node as unknown as {
      elementHandle(): Promise<ElementHandle | null>;
    }).elementHandle();

    if (!handle) {
      throw new BrowserToolError(
        `O nó ${uid} (${target.node.role}) não tem um elemento clicável associado. ` +
          `Tente o uid do elemento pai ou filho.`
      );
    }
    return handle;
  }

  /**
   * role+name que o snapshot registrou para aquele uid. As ferramentas de
   * interação usam o PAPEL para escolher como agir — preencher um `textbox` é
   * digitar, um `combobox` é selecionar, um `checkbox` é clicar — sem precisar
   * inspecionar o DOM (o que exigiria callback tipado dentro da página).
   */
  async entryOfUid(pageId: string, uid: string): Promise<{ role: string; name: string } | null> {
    const parsed = parseUid(uid);
    if (!parsed) return null;
    const stored = await this.storage.get<StoredSnapshot>(K.snapshot(pageId));
    return stored?.entries[parsed.index] ?? null;
  }

  /** Descrição curta de um nó, para a resposta das ferramentas de interação. */
  async describeUid(pageId: string, uid: string): Promise<string> {
    const entry = await this.entryOfUid(pageId, uid);
    if (!entry) return uid;
    return entry.name ? `${entry.role} ${JSON.stringify(entry.name)}` : entry.role;
  }

  /** Invalida o snapshot da aba — chamado depois de qualquer coisa que mexe no DOM. */
  async invalidateSnapshot(pageId: string): Promise<void> {
    await this.storage.delete(K.snapshot(pageId));
  }

  private async nextPageId(): Promise<string> {
    const next = (await this.storage.get<number>(K.nextPage)) ?? 0;
    await this.storage.put(K.nextPage, next + 1);
    return `page_${next}`;
  }
}

/**
 * Dono do ciclo de vida da sessão. Uma instância por Durable Object, ou seja,
 * uma por conexão do Claude.
 */
export class BrowserSession {
  private ledger: BudgetLedger;

  constructor(
    private env: Env,
    private config: Config,
    private storage: DurableObjectStorage
  ) {
    this.ledger = new BudgetLedger(env.BROWSER_KV, config.dailyBudgetSeconds);
  }

  get budget(): BudgetLedger {
    return this.ledger;
  }

  /**
   * Abre (ou reaproveita) a sessão, roda o trabalho e SEMPRE desconecta.
   * Desconectar é obrigatório: enquanto o Worker segura a conexão, nenhuma
   * outra chamada consegue falar com aquele Chromium.
   */
  async run<T>(work: (handle: SessionHandle) => Promise<T>): Promise<T> {
    await this.assertBudget();

    const { browser, launched } = await this.connect();
    try {
      const handle = await this.buildHandle(browser);
      handle.launchedNow = launched;
      return await work(handle);
    } finally {
      await browser.disconnect().catch(() => {});
    }
  }

  /**
   * Se o orçamento acabou, não basta recusar: uma sessão que ficou aberta
   * continuaria queimando o dia seguinte. Fechamos antes de propagar o erro.
   */
  private async assertBudget(): Promise<void> {
    try {
      await this.ledger.assertCanOpen();
    } catch (err) {
      if (err instanceof BudgetExceededError) await this.close().catch(() => {});
      throw err;
    }
  }

  private async connect(): Promise<{ browser: Browser; launched: boolean }> {
    const storedId = await this.storage.get<string>(K.sessionId);
    if (storedId) {
      try {
        return { browser: await puppeteer.connect(this.env.BROWSER, storedId), launched: false };
      } catch {
        // A sessão morreu (keep_alive estourou, ou a Cloudflare a reciclou).
        // Tudo que era daquela sessão — abas, buffers — é lixo agora.
        await this.forget();
      }
    }

    const options: WorkersLaunchOptions = { keep_alive: this.config.keepAliveMs };
    if (this.config.allowedDomains.length) {
      options.guardrails = { allowedDomains: this.config.allowedDomains };
    }

    let browser: Browser;
    try {
      browser = await puppeteer.launch(this.env.BROWSER, options);
    } catch (err) {
      throw await this.explainLaunchFailure(err);
    }

    const sessionId = browser.sessionId();
    await this.storage.put(K.sessionId, sessionId);
    await this.ledger.recordOpen(sessionId);

    // Só aqui, uma vez por sessão: cobra as sessões que morreram sem passar
    // pelo fechamento (Worker descartado no meio, keep_alive estourado).
    const active = await puppeteer.sessions(this.env.BROWSER).catch(() => []);
    await this.ledger
      .settleAbandoned(active.map((session) => session.sessionId))
      .catch(() => 0);

    return { browser, launched: true };
  }

  /** Erro de launch com o motivo provável — quase sempre é limite de concorrência. */
  private async explainLaunchFailure(err: unknown): Promise<Error> {
    const message = err instanceof Error ? err.message : String(err);
    const limits = await puppeteer.limits(this.env.BROWSER).catch(() => null);
    if (!limits) return new BrowserToolError(`Não consegui abrir o navegador: ${message}`);

    const waitSeconds = Math.ceil((limits.timeUntilNextAllowedBrowserAcquisition ?? 0) / 1000);
    return new BrowserToolError(
      `Não consegui abrir o navegador: ${message}. ` +
        `Sessões ativas na conta: ${limits.activeSessions.length}/${limits.maxConcurrentSessions}; ` +
        `novas permitidas agora: ${limits.allowedBrowserAcquisitions}` +
        (waitSeconds > 0 ? `; tente de novo em ~${waitSeconds}s.` : '.')
    );
  }

  /** Reconcilia o registro de abas com o que o Chromium realmente tem aberto. */
  private async buildHandle(browser: Browser): Promise<SessionHandle> {
    const pages = await browser.pages();
    const byTarget = new Map<string, Page>();
    for (const page of pages) {
      byTarget.set(await targetIdOf(page), page);
    }

    const stored = (await this.storage.get<PageRecord[]>(K.pages)) ?? [];
    const alive = stored.filter((record) => byTarget.has(record.targetId));
    const gone = stored.filter((record) => !byTarget.has(record.targetId));
    for (const record of gone) {
      await this.storage.delete([
        K.console(record.id),
        K.network(record.id),
        K.dialogs(record.id),
        K.snapshot(record.id),
      ]);
    }

    // Abas que apareceram sem passar por new_page (popups, target=_blank).
    const known = new Set(alive.map((record) => record.targetId));
    let next = (await this.storage.get<number>(K.nextPage)) ?? 0;
    for (const targetId of byTarget.keys()) {
      if (known.has(targetId)) continue;
      alive.push({ id: `page_${next}`, targetId });
      next += 1;
    }
    await this.storage.put(K.nextPage, next);
    await this.storage.put(K.pages, alive);

    let selected = (await this.storage.get<string>(K.selected)) ?? null;
    if (selected && !alive.some((record) => record.id === selected)) {
      selected = alive[0]?.id ?? null;
      if (selected) await this.storage.put(K.selected, selected);
      else await this.storage.delete(K.selected);
    }

    return new SessionHandle(browser, this.storage, this.config, alive, byTarget, selected);
  }

  /**
   * Fecha a sessão de verdade (para o relógio da cobrança) e liquida o gasto.
   * Idempotente: sem sessão registrada, não faz nada e devolve false.
   */
  async close(): Promise<{ closed: boolean; spentSeconds: number }> {
    const sessionId = await this.storage.get<string>(K.sessionId);
    if (!sessionId) return { closed: false, spentSeconds: 0 };

    try {
      const browser = await puppeteer.connect(this.env.BROWSER, sessionId);
      await browser.close();
    } catch {
      // Já estava fechada. O `settle` abaixo continua valendo: o tempo foi gasto.
    }
    const spentSeconds = await this.ledger.settle(sessionId);
    await this.forget();
    return { closed: true, spentSeconds };
  }

  /** Esquece o estado desta sessão sem tentar falar com o navegador. */
  private async forget(): Promise<void> {
    const records = (await this.storage.get<PageRecord[]>(K.pages)) ?? [];
    const keys = [K.sessionId, K.pages, K.selected];
    for (const record of records) {
      keys.push(K.console(record.id), K.network(record.id), K.dialogs(record.id), K.snapshot(record.id));
    }
    await this.storage.delete(keys);
  }

  async hasSession(): Promise<boolean> {
    return (await this.storage.get<string>(K.sessionId)) !== undefined;
  }

  /** Estado atual, para a ferramenta browser_status e a página /status. */
  async status(): Promise<{
    sessionId: string | null;
    pages: number;
    budget: Awaited<ReturnType<BudgetLedger['report']>>;
    limits: { active: number; max: number; allowedNow: number } | null;
  }> {
    const [sessionId, records, budget, limits] = await Promise.all([
      this.storage.get<string>(K.sessionId),
      this.storage.get<PageRecord[]>(K.pages),
      this.ledger.report(),
      puppeteer.limits(this.env.BROWSER).catch(() => null),
    ]);
    return {
      sessionId: sessionId ?? null,
      pages: records?.length ?? 0,
      budget,
      limits: limits
        ? {
            active: limits.activeSessions.length,
            max: limits.maxConcurrentSessions,
            allowedNow: limits.allowedBrowserAcquisitions,
          }
        : null,
    };
  }
}

export { BrowserToolError, makeUid };
