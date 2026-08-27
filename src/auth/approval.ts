// Cookie assinado de "eu já aprovei este cliente MCP".
//
// Sem isso, toda vez que o Claude reconectasse você veria de novo a tela de
// consentimento. O cookie guarda a lista de client_ids aprovados, assinada com
// HMAC-SHA256 usando COOKIE_ENCRYPTION_KEY. É assinatura, não criptografia: o
// conteúdo não é secreto (são ids de cliente), o que importa é ninguém poder
// forjar uma aprovação.

const COOKIE_NAME = 'mcp-approved-clients';
const ONE_YEAR = 60 * 60 * 24 * 365;

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Lê a lista de clientes aprovados, descartando o cookie se a assinatura não bater. */
export async function getApprovedClients(request: Request, secret: string): Promise<string[]> {
  const raw = parseCookies(request.headers.get('Cookie'))[COOKIE_NAME];
  if (!raw) return [];

  const separator = raw.indexOf('.');
  if (separator < 0) return [];
  const signature = fromHex(raw.slice(0, separator));
  const payload = raw.slice(separator + 1);
  if (!signature || !payload) return [];

  try {
    const key = await importKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(payload)
    );
    if (!valid) return [];

    const list = JSON.parse(atob(payload)) as unknown;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    // Cookie corrompido — trata como "nunca aprovou".
    return [];
  }
}

export async function clientIsApproved(
  request: Request,
  secret: string,
  clientId: string
): Promise<boolean> {
  return (await getApprovedClients(request, secret)).includes(clientId);
}

/** Monta o valor do Set-Cookie com o clientId adicionado à lista aprovada. */
export async function buildApprovalCookie(
  request: Request,
  secret: string,
  clientId: string
): Promise<string> {
  const approved = await getApprovedClients(request, secret);
  if (!approved.includes(clientId)) approved.push(clientId);

  const payload = btoa(JSON.stringify(approved));
  const key = await importKey(secret);
  const signature = toHex(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  );

  return (
    `${COOKIE_NAME}=${signature}.${payload}; ` +
    `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ONE_YEAR}`
  );
}
