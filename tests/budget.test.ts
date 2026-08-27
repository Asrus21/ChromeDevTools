// O orçamento é a defesa contra fatura surpresa. Testado com KV de mentira,
// nunca contra a conta real.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  BudgetExceededError,
  BudgetLedger,
  MAX_SESSION_SECONDS,
  dayKey,
  elapsedSeconds,
  summarize,
} from '../src/browser/budget.ts';
import { FakeKV, asKV } from './kvmock.ts';

const DAY = Date.UTC(2026, 7, 27, 12, 0, 0);

test('dayKey usa UTC, que é o fuso do free tier', () => {
  assert.equal(dayKey(Date.UTC(2026, 7, 27, 23, 59, 0)), '2026-08-27');
  assert.equal(dayKey(Date.UTC(2026, 7, 28, 0, 1, 0)), '2026-08-28');
});

test('elapsedSeconds tem teto contra registro órfão', () => {
  assert.equal(elapsedSeconds(DAY, DAY + 30_000), 30);
  // Um registro de sessão que ficou para trás não pode cobrar um dia inteiro.
  assert.equal(elapsedSeconds(DAY, DAY + 86_400_000), MAX_SESSION_SECONDS);
  // Relógio andando para trás não vira crédito.
  assert.equal(elapsedSeconds(DAY, DAY - 5_000), 0);
});

test('summarize conta a sessão que ainda está aberta', () => {
  const report = summarize('2026-08-27', 100, [{ sessionId: 'a', startedAt: DAY - 60_000 }], 480, DAY);
  assert.equal(report.usedSeconds, 160);
  assert.equal(report.remainingSeconds, 320);
  assert.equal(report.openSessions, 1);
});

test('abrir e liquidar uma sessão soma no dia certo', async () => {
  const kv = new FakeKV();
  const ledger = new BudgetLedger(asKV(kv), 480);

  await ledger.recordOpen('sess-1', DAY);
  const during = await ledger.report(DAY + 20_000);
  assert.equal(during.usedSeconds, 20, 'sessão aberta já conta enquanto roda');

  const spent = await ledger.settle('sess-1', DAY + 90_000);
  assert.equal(spent, 90);

  const after = await ledger.report(DAY + 120_000);
  assert.equal(after.usedSeconds, 90, 'depois de fechada, conta o tempo real');
  assert.equal(after.openSessions, 0);
  assert.equal(after.remainingSeconds, 390);
});

test('liquidar duas vezes não cobra duas vezes', async () => {
  const kv = new FakeKV();
  const ledger = new BudgetLedger(asKV(kv), 480);
  await ledger.recordOpen('sess-1', DAY);
  await ledger.settle('sess-1', DAY + 30_000);

  assert.equal(await ledger.settle('sess-1', DAY + 60_000), 0);
  assert.equal((await ledger.report(DAY + 60_000)).usedSeconds, 30);
});

test('o consumo entra no dia em que a sessão começou', async () => {
  const kv = new FakeKV();
  const ledger = new BudgetLedger(asKV(kv), 480);
  const beforeMidnight = Date.UTC(2026, 7, 27, 23, 59, 0);

  await ledger.recordOpen('sess-1', beforeMidnight);
  await ledger.settle('sess-1', beforeMidnight + 120_000); // já é dia 28

  assert.equal(kv.store.get('usage:2026-08-27'), '120');
  assert.equal(kv.store.get('usage:2026-08-28'), undefined);
});

test('assertCanOpen recusa quando o dia acabou', async () => {
  const kv = new FakeKV();
  const ledger = new BudgetLedger(asKV(kv), 60);

  await ledger.recordOpen('sess-1', DAY);
  await ledger.settle('sess-1', DAY + 61_000);

  await assert.rejects(
    () => ledger.assertCanOpen(DAY + 62_000),
    (err: unknown) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.match(err.message, /Orçamento diário/);
      return true;
    }
  );
});

test('sessão que sumiu sem fechar é cobrada na próxima abertura', async () => {
  const kv = new FakeKV();
  const ledger = new BudgetLedger(asKV(kv), 480);

  // O Worker morreu no meio: ficou o registro de aberta, sem liquidação.
  await ledger.recordOpen('orfa', DAY);
  await ledger.recordOpen('viva', DAY + 10_000);

  const settled = await ledger.settleAbandoned(['viva'], DAY + 70_000);
  assert.equal(settled, 70, 'só a órfã foi liquidada');

  const report = await ledger.report(DAY + 70_000);
  assert.equal(report.openSessions, 1, 'a viva continua aberta');
  assert.equal(report.usedSeconds, 130, '70 liquidados + 60 da sessão viva');
});
