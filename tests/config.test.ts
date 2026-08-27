// Os defaults de custo são a única coisa entre um erro de digitação e uma
// fatura — então eles têm teste.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { readConfig, readList, readNumber } from '../src/config.ts';

test('readNumber cai no default quando o valor não é número', () => {
  assert.equal(readNumber(undefined, 480, 30, 86400), 480);
  assert.equal(readNumber('', 480, 30, 86400), 480);
  assert.equal(readNumber('abc', 480, 30, 86400), 480);
  assert.equal(readNumber('600', 480, 30, 86400), 600);
});

test('readNumber grampeia em vez de rejeitar', () => {
  // Uma variável mal digitada não pode derrubar o servidor no primeiro request.
  assert.equal(readNumber('999999', 480, 30, 86400), 86400);
  assert.equal(readNumber('-5', 480, 30, 86400), 30);
});

test('config sem variável nenhuma usa os defaults do plano Free', () => {
  const config = readConfig({});
  assert.equal(config.dailyBudgetSeconds, 480);
  assert.equal(config.keepAliveMs, 60_000);
  assert.equal(config.idleCloseSeconds, 45);
  assert.equal(config.maxPages, 2);
  assert.deepEqual(config.allowedDomains, []);
  assert.equal(config.dialogDefault, 'dismiss');
  assert.equal(config.timeoutMs, 30_000);
});

test('keep_alive respeita o mínimo e o máximo da Cloudflare', () => {
  assert.equal(readConfig({ BROWSER_KEEP_ALIVE_SECONDS: '10' }).keepAliveMs, 60_000);
  assert.equal(readConfig({ BROWSER_KEEP_ALIVE_SECONDS: '5000' }).keepAliveMs, 600_000);
});

test('o fechamento por ociosidade nunca passa do keep_alive', () => {
  // Um alarme depois do keep_alive só acordaria o Durable Object para
  // descobrir que a Cloudflare já tinha fechado a sessão.
  const config = readConfig({
    BROWSER_KEEP_ALIVE_SECONDS: '60',
    BROWSER_IDLE_CLOSE_SECONDS: '300',
  });
  assert.equal(config.idleCloseSeconds, 60);
});

test('lista de domínios é normalizada', () => {
  assert.deepEqual(readList(' Example.com , *.GitHub.com ,, '), [
    'example.com',
    '*.github.com',
  ]);
  assert.deepEqual(readList(undefined), []);
});

test('resposta a diálogos só aceita accept explicitamente', () => {
  assert.equal(readConfig({ BROWSER_DIALOG_DEFAULT: 'accept' }).dialogDefault, 'accept');
  assert.equal(readConfig({ BROWSER_DIALOG_DEFAULT: 'ACCEPT' }).dialogDefault, 'accept');
  assert.equal(readConfig({ BROWSER_DIALOG_DEFAULT: 'talvez' }).dialogDefault, 'dismiss');
});
