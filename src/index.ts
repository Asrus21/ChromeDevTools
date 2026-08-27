// Chrome DevTools MCP Server — ponto de entrada do Worker.
//
// Duas peças:
//
//   ChromeDevToolsMCP (Durable Object)
//     Mantém a sessão MCP viva entre as chamadas do Claude e guarda o que
//     precisa atravessá-las: o id da sessão de navegador, o registro de abas,
//     o histórico de console/rede e o último snapshot. Recebe em `this.props`
//     a identidade gravada no grant OAuth.
//
//   OAuthProvider (o export default)
//     Fica na frente de tudo. Requisições para /mcp precisam de um token válido
//     e são repassadas ao Durable Object; qualquer outra coisa (/, /authorize,
//     /callback) cai no githubAuthHandler.
//
// O ponto delicado do desenho está no ciclo de vida do NAVEGADOR, não da
// sessão MCP. O Browser Rendering cobra por tempo aberto, então cada chamada
// de ferramenta reprograma um alarme que fecha o Chromium depois de
// BROWSER_IDLE_CLOSE_SECONDS parado. Sem isso, uma conversa que termina no
// meio deixaria um navegador ligado até o keep_alive estourar.

import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import OAuthProvider from '@cloudflare/workers-oauth-provider';

import { githubAuthHandler } from './auth/handler.ts';
import { BrowserSession, type SessionHandle } from './browser/session.ts';
import { type Config, readConfig } from './config.ts';
import { registerAllTools } from './tools/index.ts';
import type { Env, GitHubProps } from './types.ts';

/** Chave do agendamento de fechamento por ociosidade, no storage do DO. */
const IDLE_SCHEDULE_KEY = 'cdp:idleSchedule';

export class ChromeDevToolsMCP extends McpAgent<Env, never, GitHubProps> {
  server = new McpServer({
    name: 'chrome-devtools-mcp-worker',
    version: '1.0.0',
  });

  /**
   * Config e sessão são getters, não campos criados no `init()`, porque o
   * Durable Object também acorda pelo ALARME — e aí o `init()` do MCP não
   * rodou. Ambos são baratos de montar: leem variáveis de ambiente e guardam
   * referências, sem I/O.
   */
  private get config(): Config {
    return readConfig(this.env);
  }

  private get session(): BrowserSession {
    return new BrowserSession(this.env, this.config, this.ctx.storage);
  }

  async init(): Promise<void> {
    // `props` vem do grant OAuth, já descriptografado pelo OAuthProvider. Sem
    // ele não há identidade — melhor falhar aqui do que dar erro obscuro em
    // cada ferramenta.
    if (!this.props?.login) {
      throw new Error(
        'Sessão sem identidade do GitHub. Desconecte e reconecte o servidor MCP.'
      );
    }

    const config = this.config;
    const session = this.session;

    registerAllTools(this.server, {
      config,
      session,
      run: <T>(work: (handle: SessionHandle) => Promise<T>) => this.runTool(session, work),
    });
  }

  /**
   * O caminho por onde toda ferramenta que toca o navegador passa. O `finally`
   * é o que garante o fechamento: mesmo quando a ferramenta falha, o navegador
   * ficou aberto e alguém precisa marcar a hora de apagar a luz.
   */
  private async runTool<T>(
    session: BrowserSession,
    work: (handle: SessionHandle) => Promise<T>
  ): Promise<T> {
    try {
      return await session.run(work);
    } finally {
      await this.scheduleIdleClose().catch(() => {});
    }
  }

  /**
   * Reprograma o fechamento por ociosidade. Cancelar o anterior é essencial:
   * sem isso, cada chamada deixaria um alarme órfão e o primeiro deles fecharia
   * o navegador no meio do trabalho.
   */
  private async scheduleIdleClose(): Promise<void> {
    const previous = await this.ctx.storage.get<string>(IDLE_SCHEDULE_KEY);
    if (previous) await this.cancelSchedule(previous).catch(() => {});

    const scheduled = await this.schedule(this.config.idleCloseSeconds, 'closeIdleBrowser');
    await this.ctx.storage.put(IDLE_SCHEDULE_KEY, scheduled.id);
  }

  /**
   * Chamado pelo alarme. Público porque é o `schedule()` do agents que invoca
   * pelo nome — não é parte da API MCP.
   */
  async closeIdleBrowser(): Promise<void> {
    await this.ctx.storage.delete(IDLE_SCHEDULE_KEY);
    const { closed, spentSeconds } = await this.session.close();
    if (closed) {
      console.log(
        `[browser] sessão fechada por ociosidade após ${spentSeconds}s de navegador aberto`
      );
    }
  }
}

export default new OAuthProvider({
  apiHandlers: {
    // Transporte moderno (Streamable HTTP) — é o que o Claude usa hoje.
    '/mcp': ChromeDevToolsMCP.serve('/mcp', { binding: 'MCP_OBJECT' }),
    // SSE, mantido para clientes MCP mais antigos.
    '/sse': ChromeDevToolsMCP.serveSSE('/sse', { binding: 'MCP_OBJECT' }),
  },
  defaultHandler: githubAuthHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
});
