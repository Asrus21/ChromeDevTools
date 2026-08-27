// O cookie de aprovação é o que evita repetir a tela de consentimento a cada
// reconexão do Claude. Ele é assinado, não criptografado — o teste que
// importa é o de forjar.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildApprovalCookie,
  clientIsApproved,
  getApprovedClients,
} from '../src/auth/approval.ts';

const SECRET = 'segredo-de-teste-bem-comprido-para-o-hmac';

/** Monta um Request com o cookie que o servidor teria devolvido. */
function requestWithCookie(setCookie: string): Request {
  const value = setCookie.split(';')[0] ?? '';
  return new Request('https://exemplo.workers.dev/authorize', {
    headers: { Cookie: value },
  });
}

const bare = (): Request => new Request('https://exemplo.workers.dev/authorize');

test('sem cookie, ninguém está aprovado', async () => {
  assert.deepEqual(await getApprovedClients(bare(), SECRET), []);
  assert.equal(await clientIsApproved(bare(), SECRET, 'cliente-1'), false);
});

test('o cookie assinado sobrevive à ida e volta', async () => {
  const cookie = await buildApprovalCookie(bare(), SECRET, 'cliente-1');
  const request = requestWithCookie(cookie);

  assert.deepEqual(await getApprovedClients(request, SECRET), ['cliente-1']);
  assert.equal(await clientIsApproved(request, SECRET, 'cliente-1'), true);
  assert.equal(await clientIsApproved(request, SECRET, 'outro'), false);
});

test('aprovar um segundo cliente acumula, não substitui', async () => {
  const first = await buildApprovalCookie(bare(), SECRET, 'cliente-1');
  const second = await buildApprovalCookie(requestWithCookie(first), SECRET, 'cliente-2');

  assert.deepEqual(await getApprovedClients(requestWithCookie(second), SECRET), [
    'cliente-1',
    'cliente-2',
  ]);
});

test('aprovar o mesmo cliente duas vezes não duplica', async () => {
  const first = await buildApprovalCookie(bare(), SECRET, 'cliente-1');
  const second = await buildApprovalCookie(requestWithCookie(first), SECRET, 'cliente-1');
  assert.deepEqual(await getApprovedClients(requestWithCookie(second), SECRET), ['cliente-1']);
});

test('cookie assinado com outra chave é descartado', async () => {
  const cookie = await buildApprovalCookie(bare(), SECRET, 'cliente-1');
  assert.deepEqual(await getApprovedClients(requestWithCookie(cookie), 'outra-chave'), []);
});

test('payload adulterado é descartado', async () => {
  const cookie = await buildApprovalCookie(bare(), SECRET, 'cliente-1');
  const [nameAndSignature, payload] = (cookie.split(';')[0] ?? '').split('.');

  // O invasor troca a lista de clientes mantendo a assinatura original.
  const forged = btoa(JSON.stringify(['cliente-do-invasor']));
  assert.notEqual(forged, payload);

  const request = new Request('https://exemplo.workers.dev/authorize', {
    headers: { Cookie: `${nameAndSignature}.${forged}` },
  });
  assert.deepEqual(await getApprovedClients(request, SECRET), []);
});

test('cookie malformado não derruba o servidor', async () => {
  for (const raw of [
    'mcp-approved-clients=',
    'mcp-approved-clients=semponto',
    'mcp-approved-clients=zz.zz',
    'mcp-approved-clients=abc.###',
    'mcp-approved-clients=.',
  ]) {
    const request = new Request('https://exemplo.workers.dev/authorize', {
      headers: { Cookie: raw },
    });
    assert.deepEqual(await getApprovedClients(request, SECRET), [], `falhou em: ${raw}`);
  }
});

test('o Set-Cookie tem as flags de segurança', async () => {
  const cookie = await buildApprovalCookie(bare(), SECRET, 'cliente-1');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
});
