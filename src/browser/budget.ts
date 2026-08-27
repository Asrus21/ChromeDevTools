// Contabilidade de minutos de navegador.
//
// A Cloudflare cobra Browser Rendering por TEMPO DE NAVEGADOR ABERTO, não por
// comando executado: um Chromium parado com keep_alive custa igual a um
// trabalhando. Então o que este arquivo mede é tempo de parede entre abrir e
// fechar a sessão — a mesma coisa que a fatura mede.
//
// Fica em KV, e não no storage do Durable Object, porque o orçamento é da
// CONTA: duas conexões do Claude são dois Durable Objects, e cada um acharia
// que tem o dia inteiro para gastar.
//
// É uma estimativa, não a fatura. KV não é transacional, então duas sessões
// abrindo no mesmo instante podem contar uma escrita a menos. A trava real
// contra susto é a soma disto com o keep_alive curto e o alarme de ociosidade;
// o número oficial está sempre no painel da Cloudflare.

/** Uma sessão de navegador aberta e ainda não liquidada. */
export interface OpenSession {
  sessionId: string;
  startedAt: number;
}

export interface BudgetReport {
  day: string;
  usedSeconds: number;
  budgetSeconds: number;
  remainingSeconds: number;
  openSessions: number;
}

const USAGE_PREFIX = 'usage:';
const OPEN_PREFIX = 'open:';
/** Guarda o consumo de alguns dias para dar contexto, depois some sozinho. */
const USAGE_TTL_SECONDS = 60 * 60 * 24 * 4;
/**
 * Nenhuma sessão da Cloudflare passa de 10 minutos de keep_alive, então um
 * registro de sessão aberta que sobreviva a uma hora é lixo de crash.
 */
const OPEN_TTL_SECONDS = 60 * 60;
/**
 * Teto ao liquidar uma sessão: se o registro ficou órfão (o Worker morreu
 * antes de fechar), cobramos no máximo isto em vez de "agora menos ontem".
 */
export const MAX_SESSION_SECONDS = 660;

/** Chave do dia em UTC — o mesmo fuso que a Cloudflare usa para o free tier. */
export function dayKey(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Segundos consumidos por uma sessão, com teto contra registro órfão. */
export function elapsedSeconds(startedAt: number, now: number = Date.now()): number {
  const seconds = Math.round((now - startedAt) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds, MAX_SESSION_SECONDS);
}

/** Monta o relatório a partir dos números crus. Separado para poder testar. */
export function summarize(
  day: string,
  settledSeconds: number,
  open: OpenSession[],
  budgetSeconds: number,
  now: number = Date.now()
): BudgetReport {
  // Uma sessão ainda aberta já está gastando: contamos o que ela consumiu até
  // agora, senão o orçamento só seria respeitado depois que ela fechasse.
  const live = open.reduce((total, s) => total + elapsedSeconds(s.startedAt, now), 0);
  const usedSeconds = settledSeconds + live;
  return {
    day,
    usedSeconds,
    budgetSeconds,
    remainingSeconds: Math.max(0, budgetSeconds - usedSeconds),
    openSessions: open.length,
  };
}

/** Erro de orçamento estourado — a camada de ferramentas traduz para o modelo. */
export class BudgetExceededError extends Error {
  constructor(public report: BudgetReport) {
    super(
      `Orçamento diário de navegador esgotado: ${report.usedSeconds}s de ` +
        `${report.budgetSeconds}s usados hoje (${report.day}, UTC). ` +
        `Ele zera à meia-noite UTC; para mudar o teto, ajuste ` +
        `BROWSER_DAILY_BUDGET_SECONDS no wrangler.jsonc.`
    );
    this.name = 'BudgetExceededError';
  }
}

export class BudgetLedger {
  constructor(
    private kv: KVNamespace,
    private budgetSeconds: number
  ) {}

  private async listOpen(): Promise<OpenSession[]> {
    const listed = await this.kv.list({ prefix: OPEN_PREFIX });
    const records = await Promise.all(
      listed.keys.map(async (key) => {
        const value = await this.kv.get<{ startedAt: number }>(key.name, 'json');
        if (!value || typeof value.startedAt !== 'number') return null;
        return { sessionId: key.name.slice(OPEN_PREFIX.length), startedAt: value.startedAt };
      })
    );
    return records.filter((r): r is OpenSession => r !== null);
  }

  private async settledSeconds(day: string): Promise<number> {
    const raw = await this.kv.get(USAGE_PREFIX + day);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  async report(now: number = Date.now()): Promise<BudgetReport> {
    const day = dayKey(now);
    const [settled, open] = await Promise.all([this.settledSeconds(day), this.listOpen()]);
    return summarize(day, settled, open, this.budgetSeconds, now);
  }

  /**
   * Porteiro: roda ANTES de abrir uma sessão nova. Lança se o dia já acabou.
   * Devolve o relatório para quem quiser mostrar quanto sobrou.
   */
  async assertCanOpen(now: number = Date.now()): Promise<BudgetReport> {
    const report = await this.report(now);
    if (report.remainingSeconds <= 0) throw new BudgetExceededError(report);
    return report;
  }

  async recordOpen(sessionId: string, now: number = Date.now()): Promise<void> {
    await this.kv.put(OPEN_PREFIX + sessionId, JSON.stringify({ startedAt: now }), {
      expirationTtl: OPEN_TTL_SECONDS,
    });
  }

  /** Liquida uma sessão: soma o tempo dela no dia e apaga o registro de aberta. */
  async settle(sessionId: string, now: number = Date.now()): Promise<number> {
    const key = OPEN_PREFIX + sessionId;
    const record = await this.kv.get<{ startedAt: number }>(key, 'json');
    if (!record || typeof record.startedAt !== 'number') return 0;

    const spent = elapsedSeconds(record.startedAt, now);
    // O consumo entra no dia em que a sessão COMEÇOU. Uma sessão que cruza a
    // meia-noite UTC é curta demais para valer a divisão proporcional.
    const day = dayKey(record.startedAt);
    const total = (await this.settledSeconds(day)) + spent;
    await this.kv.put(USAGE_PREFIX + day, String(total), {
      expirationTtl: USAGE_TTL_SECONDS,
    });
    await this.kv.delete(key);
    return spent;
  }

  /**
   * Cobra as sessões que sumiram sem passar pelo `settle` — o caso do Worker
   * ter sido descartado no meio, ou da Cloudflare ter fechado por keep_alive.
   *
   * @param liveSessionIds ids que a Cloudflare ainda reporta como ativos
   */
  async settleAbandoned(liveSessionIds: string[], now: number = Date.now()): Promise<number> {
    const live = new Set(liveSessionIds);
    const open = await this.listOpen();
    let settled = 0;
    for (const session of open) {
      if (live.has(session.sessionId)) continue;
      settled += await this.settle(session.sessionId, now);
    }
    return settled;
  }
}
