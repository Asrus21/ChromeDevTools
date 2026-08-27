// Tipos compartilhados do Chrome DevTools MCP Server.

import type { BrowserWorker } from '@cloudflare/puppeteer';

/**
 * Bindings e variáveis de ambiente do Worker.
 *
 * Os secrets (GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY) NUNCA vão para o
 * wrangler.jsonc — são definidos com `wrangler secret put` (produção) ou no
 * arquivo .dev.vars (local, fora do git).
 */
export interface Env {
  /** KV usado pelo OAuthProvider para clients, grants e tokens do MCP. */
  OAUTH_KV: KVNamespace;
  /**
   * KV do estado que precisa ser GLOBAL, e não por conexão: o orçamento
   * diário de minutos de navegador. Todo Durable Object lê e escreve aqui,
   * senão duas conexões do Claude gastariam dois orçamentos.
   */
  BROWSER_KV: KVNamespace;
  /** Durable Object que hospeda a sessão MCP. */
  MCP_OBJECT: DurableObjectNamespace;
  /** Binding do Browser Rendering (Chromium headless gerenciado pela Cloudflare). */
  BROWSER: BrowserWorker;

  /** Client ID do OAuth App do GitHub. Público — pode ficar no wrangler.jsonc. */
  GITHUB_CLIENT_ID: string;
  /** Client Secret do mesmo OAuth App. Secret — nunca commitado. */
  GITHUB_CLIENT_SECRET: string;
  /**
   * Logins do GitHub autorizados a conectar neste servidor, separados por
   * vírgula (ex.: "asrus21"). Como o Worker fica numa URL pública, essa lista
   * é o que impede um terceiro de conectar o Claude dele aqui e gastar o SEU
   * orçamento de Browser Rendering. Equivalente ao ALLOWED_TWITCH_LOGINS.
   */
  ALLOWED_GITHUB_LOGINS: string;
  /** Chave para assinar o cookie de "já aprovei este cliente". Secret. */
  COOKIE_ENCRYPTION_KEY: string;

  // ---------------------------------------------------------------- custo
  // Todas opcionais: sem elas valem os defaults do plano Free (src/config.ts).

  /** Teto de segundos de navegador por dia (UTC). Default: 480 (8 min). */
  BROWSER_DAILY_BUDGET_SECONDS?: string;
  /** keep_alive da sessão, em segundos. Default: 60. Máximo aceito pela CF: 600. */
  BROWSER_KEEP_ALIVE_SECONDS?: string;
  /** Fecha a sessão após N segundos sem nenhuma ferramenta. Default: 45. */
  BROWSER_IDLE_CLOSE_SECONDS?: string;
  /** Máximo de abas simultâneas. Default: 2. */
  BROWSER_MAX_PAGES?: string;
  /**
   * Domínios que o navegador pode acessar, separados por vírgula
   * (ex.: "example.com,*.github.com"). Vazio = sem restrição de domínio.
   * Aplicado como `guardrails` na criação da sessão — a trava é do lado da
   * Cloudflare, não nossa, e não pode ser afrouxada depois que a sessão nasce.
   */
  BROWSER_ALLOWED_DOMAINS?: string;
  /** O que fazer com alert/confirm/prompt: "dismiss" (default) ou "accept". */
  BROWSER_DIALOG_DEFAULT?: string;
  /** Timeout padrão de navegação/espera, em ms. Default: 30000. */
  BROWSER_TIMEOUT_MS?: string;

  /** Injetado pelo OAuthProvider em runtime. */
  OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
}

/**
 * Props do grant OAuth — o que o OAuthProvider criptografa no token do MCP e
 * devolve para o Durable Object em `this.props`.
 *
 * Só a identidade mora aqui. Não guardamos o token do GitHub: ele serve
 * apenas para descobrir QUEM está autorizando, e depois disso é descartado.
 */
export type GitHubProps = {
  userId: string;
  login: string;
  name: string;
  avatarUrl: string;
};

/** Usuário do GitHub, como retornado por GET /user. */
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

/** Uma aba registrada, do jeito que fica persistida no storage do DO. */
export interface PageRecord {
  /** Id curto e estável que o modelo usa nas ferramentas (page_0, page_1...). */
  id: string;
  /** Id do target no CDP — é o que sobrevive a reconexões do Worker. */
  targetId: string;
}

/** Uma mensagem de console coletada dentro da página. */
export interface ConsoleEntry {
  type: string;
  text: string;
  at: number;
  stack?: string | null;
}

/** Uma requisição de rede observada dentro da página. */
export interface NetworkEntry {
  url: string;
  method?: string | null;
  status?: number | null;
  type?: string | null;
  ms?: number | null;
  bytes?: number | null;
  at: number;
  via: 'perf' | 'fetch' | 'xhr' | 'navigation';
}

/** Um diálogo (alert/confirm/prompt) interceptado. */
export interface DialogEntry {
  kind: string;
  message: string;
  at: number;
  handledAs: string;
}

/** O que o coletor devolve quando drenamos os buffers da página. */
export interface CollectorDrain {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  dialogs: DialogEntry[];
}

/** Snapshot de acessibilidade guardado para resolver os uids depois. */
export interface StoredSnapshot {
  /** Sequência do snapshot; entra no uid (`<seq>_<índice>`). */
  seq: number;
  /** role+name de cada nó, na ordem da travessia — usado para detectar staleness. */
  entries: { role: string; name: string }[];
  /**
   * Se o snapshot foi tirado com a árvore completa. Precisa ficar registrado:
   * resolver um uid exige refazer o snapshot com a MESMA opção, senão os
   * índices andam e o uid aponta para outro nó.
   */
  verbose: boolean;
  takenAt: number;
}
