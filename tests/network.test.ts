// A fusão das duas fontes de rede: sem ela, cada fetch apareceria duas vezes
// na lista, uma com método e outra com bytes.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { filterNetworkEntries, mergeNetworkEntries } from '../src/browser/network.ts';
import type { NetworkEntry } from '../src/types.ts';

const T = 1_000_000;

const entry = (over: Partial<NetworkEntry> & { url: string; via: NetworkEntry['via'] }): NetworkEntry => ({
  at: T,
  method: null,
  status: null,
  type: null,
  ms: null,
  bytes: null,
  ...over,
});

test('perf e fetch da mesma URL viram uma linha só', () => {
  const merged = mergeNetworkEntries([
    entry({ url: 'https://a/api', via: 'perf', status: 200, bytes: 512, type: 'fetch', ms: 30 }),
    entry({ url: 'https://a/api', via: 'fetch', method: 'POST', status: 200, ms: 33, at: T + 100 }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.method, 'POST', 'o método só existe no patch de fetch');
  assert.equal(merged[0]?.bytes, 512, 'os bytes só existem no PerformanceObserver');
});

test('mesma URL fora da janela de tempo são requisições diferentes', () => {
  const merged = mergeNetworkEntries([
    entry({ url: 'https://a/api', via: 'perf', status: 200 }),
    entry({ url: 'https://a/api', via: 'fetch', method: 'GET', at: T + 10_000 }),
  ]);
  assert.equal(merged.length, 2);
});

test('duas chamadas próximas casam com um perf cada, não com o mesmo', () => {
  const merged = mergeNetworkEntries([
    entry({ url: 'https://a/api', via: 'perf', status: 200, bytes: 10 }),
    entry({ url: 'https://a/api', via: 'perf', status: 500, bytes: 20, at: T + 500 }),
    entry({ url: 'https://a/api', via: 'fetch', method: 'GET', at: T + 50 }),
    entry({ url: 'https://a/api', via: 'fetch', method: 'GET', at: T + 550 }),
  ]);
  assert.equal(merged.length, 2, 'nenhum perf pode ser consumido duas vezes');
});

test('recurso sem par continua na lista', () => {
  const merged = mergeNetworkEntries([
    entry({ url: 'https://a/logo.png', via: 'perf', type: 'img', status: 200 }),
    entry({ url: 'https://a/', via: 'navigation', type: 'document', status: 200 }),
  ]);
  assert.equal(merged.length, 2);
});

test('o resultado sai ordenado por tempo', () => {
  const merged = mergeNetworkEntries([
    entry({ url: 'https://a/3', via: 'perf', at: T + 300 }),
    entry({ url: 'https://a/1', via: 'perf', at: T + 100 }),
    entry({ url: 'https://a/2', via: 'fetch', at: T + 200 }),
  ]);
  assert.deepEqual(
    merged.map((e) => e.url),
    ['https://a/1', 'https://a/2', 'https://a/3']
  );
});

test('onlyFailures pega erro HTTP e requisição sem resposta', () => {
  const entries = [
    entry({ url: 'https://a/ok', via: 'perf', status: 200 }),
    entry({ url: 'https://a/nao', via: 'perf', status: 404 }),
    entry({ url: 'https://a/morreu', via: 'fetch', status: null }),
  ];
  const failures = filterNetworkEntries(entries, { onlyFailures: true });
  assert.deepEqual(
    failures.map((e) => e.url),
    ['https://a/nao', 'https://a/morreu']
  );
});

test('urlContains ignora a caixa', () => {
  const entries = [
    entry({ url: 'https://API.exemplo/v1', via: 'perf' }),
    entry({ url: 'https://cdn.exemplo/x.js', via: 'perf' }),
  ];
  assert.equal(filterNetworkEntries(entries, { urlContains: 'api' }).length, 1);
});
