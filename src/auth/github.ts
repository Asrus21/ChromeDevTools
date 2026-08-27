// A conversa com o GitHub: trocar o code por um token e descobrir quem é o dono.
//
// O token do GitHub é usado UMA vez, para ler /user, e depois descartado. Não
// guardamos nada dele: este servidor não fala com a API do GitHub, ele só usa
// o GitHub como carteira de identidade para decidir quem pode gastar o
// orçamento de navegador da conta.

import type { GitHubUser } from '../types.ts';

export const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';
/** Só a identidade pública. Não pedimos repo, nem e-mail, nem nada de escrita. */
export const GITHUB_SCOPE = 'read:user';
const USER_AGENT = 'chrome-devtools-mcp-worker';

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

/** Troca o `code` do callback por um access token do GitHub. */
export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<string> {
  const response = await fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new GitHubAuthError(`O GitHub respondeu HTTP ${response.status} ao trocar o code.`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (payload.error) {
    throw new GitHubAuthError(payload.error_description || payload.error);
  }
  if (!payload.access_token) {
    throw new GitHubAuthError('O GitHub não devolveu access_token.');
  }
  return payload.access_token;
}

/** Descobre quem autorizou. Sem parâmetro nenhum, /user devolve o dono do token. */
export async function fetchUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch(GITHUB_USER, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new GitHubAuthError(`O GitHub respondeu HTTP ${response.status} em /user.`);
  }
  const user = (await response.json()) as GitHubUser;
  if (!user?.login) throw new GitHubAuthError('/user veio sem login.');
  return user;
}
