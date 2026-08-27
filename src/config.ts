// Leitura das travas de custo, num lugar só.
//
// Os defaults aqui são os do plano Workers Free (10 minutos de navegador por
// dia, 3 sessões concorrentes). Quem migrar para o Paid muda as variáveis no
// wrangler.jsonc — nenhum número de custo está enterrado no código.

/** Forma mínima do Env que a configuração precisa. Facilita testar sem Worker. */
export interface ConfigSource {
  BROWSER_DAILY_BUDGET_SECONDS?: string;
  BROWSER_KEEP_ALIVE_SECONDS?: string;
  BROWSER_IDLE_CLOSE_SECONDS?: string;
  BROWSER_MAX_PAGES?: string;
  BROWSER_ALLOWED_DOMAINS?: string;
  BROWSER_DIALOG_DEFAULT?: string;
  BROWSER_TIMEOUT_MS?: string;
}

export interface Config {
  /** Teto de segundos de navegador por dia UTC. */
  dailyBudgetSeconds: number;
  /** keep_alive passado para a Cloudflare, em ms. */
  keepAliveMs: number;
  /** Ociosidade que dispara o fechamento da sessão, em segundos. */
  idleCloseSeconds: number;
  maxPages: number;
  /** Vazio = sem restrição de domínio. */
  allowedDomains: string[];
  dialogDefault: 'dismiss' | 'accept';
  timeoutMs: number;
}

/**
 * Converte string em número dentro de uma faixa. Valor ausente, vazio ou
 * inválido cai no default; valor fora da faixa é grampeado em vez de
 * rejeitado, para uma variável mal digitada não derrubar o servidor.
 */
export function readNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** Lista separada por vírgula, normalizada (minúsculas, sem espaços, sem vazios). */
export function readList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function readConfig(env: ConfigSource): Config {
  // O limite superior do keep_alive (600s) é da Cloudflare, não nosso:
  // acima disso a sessão é recusada.
  const keepAliveSeconds = readNumber(env.BROWSER_KEEP_ALIVE_SECONDS, 60, 60, 600);
  return {
    dailyBudgetSeconds: readNumber(env.BROWSER_DAILY_BUDGET_SECONDS, 480, 30, 86_400),
    keepAliveMs: keepAliveSeconds * 1000,
    // Nunca deixamos o alarme passar do keep_alive: se ele fosse maior, a
    // Cloudflare já teria fechado a sessão antes e o alarme só acordaria o
    // Durable Object à toa.
    idleCloseSeconds: Math.min(
      readNumber(env.BROWSER_IDLE_CLOSE_SECONDS, 45, 10, 600),
      keepAliveSeconds
    ),
    maxPages: readNumber(env.BROWSER_MAX_PAGES, 2, 1, 10),
    allowedDomains: readList(env.BROWSER_ALLOWED_DOMAINS),
    dialogDefault: env.BROWSER_DIALOG_DEFAULT?.trim().toLowerCase() === 'accept'
      ? 'accept'
      : 'dismiss',
    timeoutMs: readNumber(env.BROWSER_TIMEOUT_MS, 30_000, 1_000, 120_000),
  };
}
