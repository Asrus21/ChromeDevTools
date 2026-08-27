// O "defaultHandler" do OAuthProvider: tudo que não é /mcp ou /sse passa aqui.
//
// Existem DUAS camadas de OAuth neste desenho, e confundi-las é o erro clássico:
//
//   Camada 1 — Claude  <->  este Worker
//     O Claude é um cliente OAuth. Ele se registra sozinho (Dynamic Client
//     Registration em /register), manda você para /authorize e no fim recebe um
//     token EMITIDO POR NÓS. Quem cuida disso é o @cloudflare/workers-oauth-provider.
//
//   Camada 2 — este Worker  <->  GitHub
//     Diferente do servidor da Twitch, aqui não há uma API de terceiro para
//     chamar depois: o navegador é da própria Cloudflare. O GitHub entra só
//     como carteira de identidade, para responder "quem é você" e decidir se
//     você está na lista. O token do GitHub é usado uma vez e jogado fora.
//
// O fluxo completo:
//   1. Claude   -> GET  /authorize          (pedido OAuth do MCP)
//   2. Worker   -> tela de consentimento    (pulada se já houver cookie)
//   3. Worker   -> redirect para github.com/login/oauth/authorize
//   4. GitHub   -> GET  /callback?code=...  (você logou)
//   5. Worker   -> troca code por token, lê /user, confere a lista de permitidos
//   6. Worker   -> completeAuthorization()  e devolve o Claude ao redirect dele

import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { readConfig, readList } from '../config.ts';
import type { Env, GitHubProps } from '../types.ts';
import { buildApprovalCookie, clientIsApproved } from './approval.ts';
import { GITHUB_AUTHORIZE, GITHUB_SCOPE, exchangeCodeForToken, fetchUser } from './github.ts';
import { approvalPage, errorPage, homePage } from './pages.ts';

export const SERVER_NAME = 'Chrome DevTools MCP Server';

/**
 * base64url do JSON, passando por UTF-8. `btoa` sozinho quebra em qualquer
 * caractere fora do Latin-1, e um redirect_uri com acento é suficiente.
 */
function encodeState(request: AuthRequest): string {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(value: string): AuthRequest | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as AuthRequest;
  } catch {
    return null;
  }
}

function html(body: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** Aviso de custo mostrado na tela de consentimento. */
function budgetHint(env: Env): string {
  const config = readConfig(env);
  const minutes = Math.round(config.dailyBudgetSeconds / 60);
  const domains = config.allowedDomains.length
    ? `Navegação restrita a: ${config.allowedDomains.join(', ')}.`
    : 'Sem restrição de domínio — o navegador pode ir a qualquer endereço público.';
  return (
    `Cada sessão de navegador consome o orçamento de Browser Rendering da conta ` +
    `Cloudflare. Teto configurado: ${minutes} min por dia, no máximo ` +
    `${config.maxPages} aba(s) por vez, sessão fechada após ` +
    `${config.idleCloseSeconds}s sem uso. ${domains}`
  );
}

function redirectToGitHub(
  env: Env,
  authRequest: AuthRequest,
  redirectUri: string,
  headers: HeadersInit = {}
): Response {
  const url = new URL(GITHUB_AUTHORIZE);
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('state', encodeState(authRequest));

  return new Response(null, { status: 302, headers: { Location: url.toString(), ...headers } });
}

export const githubAuthHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const callbackUri = `${url.origin}/callback`;

    if (url.pathname === '/') {
      return html(homePage(url.origin, SERVER_NAME));
    }

    // Health check simples, útil para monitorar o deploy.
    if (url.pathname === '/up') {
      return Response.json({ ok: true, server: SERVER_NAME });
    }

    // ----------------------------------------------------------- /authorize
    if (url.pathname === '/authorize') {
      if (request.method === 'GET') {
        let authRequest: AuthRequest;
        try {
          authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        } catch (err) {
          return html(
            errorPage(
              'Pedido de autorização inválido',
              err instanceof Error ? err.message : String(err)
            ),
            400
          );
        }

        const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
        if (!client) {
          return html(
            errorPage(
              'Cliente desconhecido',
              'O aplicativo que iniciou a conexão não está registrado neste servidor.'
            ),
            400
          );
        }

        if (await clientIsApproved(request, env.COOKIE_ENCRYPTION_KEY, authRequest.clientId)) {
          return redirectToGitHub(env, authRequest, callbackUri);
        }

        return html(
          approvalPage({
            clientName: client.clientName || authRequest.clientId,
            serverName: SERVER_NAME,
            allowedHint: readList(env.ALLOWED_GITHUB_LOGINS).join(', ') || '(nenhuma configurada)',
            encodedState: encodeState(authRequest),
            budgetHint: budgetHint(env),
          })
        );
      }

      if (request.method === 'POST') {
        const form = await request.formData();
        const authRequest = decodeState(String(form.get('state') || ''));
        if (!authRequest) {
          return html(
            errorPage('Sessão expirada', 'Feche esta aba e conecte novamente pelo Claude.'),
            400
          );
        }

        const cookie = await buildApprovalCookie(
          request,
          env.COOKIE_ENCRYPTION_KEY,
          authRequest.clientId
        );
        return redirectToGitHub(env, authRequest, callbackUri, { 'Set-Cookie': cookie });
      }

      return new Response('Method Not Allowed', { status: 405 });
    }

    // ------------------------------------------------------------ /callback
    if (url.pathname === '/callback') {
      const error = url.searchParams.get('error');
      if (error) {
        return html(
          errorPage(
            'Autorização negada no GitHub',
            url.searchParams.get('error_description') || error
          ),
          400
        );
      }

      const code = url.searchParams.get('code');
      const authRequest = decodeState(url.searchParams.get('state') || '');
      if (!code || !authRequest) {
        return html(
          errorPage(
            'Retorno inválido do GitHub',
            'Faltou o code ou o state. Tente conectar novamente pelo Claude.'
          ),
          400
        );
      }

      let user;
      try {
        const token = await exchangeCodeForToken(
          env.GITHUB_CLIENT_ID,
          env.GITHUB_CLIENT_SECRET,
          code,
          callbackUri
        );
        user = await fetchUser(token);
      } catch (err) {
        return html(
          errorPage(
            'Falha ao identificar a conta',
            err instanceof Error ? err.message : String(err)
          ),
          502
        );
      }

      // A trava de acesso. O Worker fica numa URL pública e o Claude registra
      // clientes sozinho: sem esta checagem, qualquer pessoa que descobrisse o
      // endereço conectaria o próprio Claude aqui e gastaria o orçamento de
      // Browser Rendering — e navegaria pela sua conta Cloudflare.
      const allowed = readList(env.ALLOWED_GITHUB_LOGINS);
      if (allowed.length === 0) {
        return html(
          errorPage(
            'Servidor mal configurado',
            'ALLOWED_GITHUB_LOGINS está vazio, então nenhum login é aceito. ' +
              'Defina a variável no wrangler.jsonc e faça o deploy de novo.'
          ),
          500
        );
      }
      if (!allowed.includes(user.login.toLowerCase())) {
        return html(
          errorPage(
            'Conta não autorizada',
            `A conta "${user.login}" não está na lista de logins permitidos deste servidor.`
          ),
          403
        );
      }

      const props: GitHubProps = {
        userId: String(user.id),
        login: user.login,
        name: user.name || user.login,
        avatarUrl: user.avatar_url,
      };

      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: props.userId,
        metadata: { label: props.name },
        scope: authRequest.scope,
        props,
      });

      return Response.redirect(redirectTo, 302);
    }

    return new Response('Not Found', { status: 404 });
  },
};

export type { OAuthHelpers };
