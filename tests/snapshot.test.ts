// O uid é o contrato entre take_snapshot e click/fill. Se a travessia deixar
// de ser determinística, o clique vai para o elemento errado — daí estes testes.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  type AxLike,
  entriesOf,
  flatten,
  makeUid,
  parseUid,
  renderSnapshot,
  stillMatches,
} from '../src/browser/snapshot.ts';

const page: AxLike = {
  role: 'RootWebArea',
  name: 'Exemplo',
  children: [
    { role: 'heading', name: 'Título', level: 1, children: [{ role: 'StaticText', name: 'Título' }] },
    { role: 'textbox', name: 'Busca', value: 'gato', required: true },
    { role: 'button', name: 'Enviar', disabled: true },
  ],
};

test('a travessia é em profundidade e estável', () => {
  const first = flatten(page);
  const second = flatten(page);
  assert.deepEqual(
    first.nodes.map((n) => n.node.role),
    ['RootWebArea', 'heading', 'StaticText', 'textbox', 'button']
  );
  assert.deepEqual(
    first.nodes.map((n) => n.index),
    second.nodes.map((n) => n.index)
  );
  assert.deepEqual(
    first.nodes.map((n) => n.depth),
    [0, 1, 2, 1, 1]
  );
});

test('árvore vazia não quebra', () => {
  const result = flatten(null);
  assert.equal(result.nodes.length, 0);
  assert.equal(result.truncated, false);
  assert.match(renderSnapshot(1, result), /vazia/);
});

test('truncar avisa e para no limite', () => {
  const result = flatten(page, 2);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.truncated, true);
  assert.match(renderSnapshot(7, result), /truncada/);
});

test('a renderização traz uid, papel, nome e estado', () => {
  const text = renderSnapshot(3, flatten(page));
  assert.match(text, /uid=3_0 RootWebArea "Exemplo"/);
  assert.match(text, /^ {2}uid=3_1 heading "Título" level=1$/m);
  assert.match(text, /uid=3_3 textbox "Busca" value="gato" required/);
  assert.match(text, /uid=3_4 button "Enviar" disabled/);
});

test('uid vai e volta', () => {
  assert.equal(makeUid(3, 42), '3_42');
  assert.deepEqual(parseUid('3_42'), { seq: 3, index: 42 });
  assert.deepEqual(parseUid(' 3_42 '), { seq: 3, index: 42 });
  for (const invalid of ['', 'abc', '3', '3_', '_4', '3_4_5', '3-4']) {
    assert.equal(parseUid(invalid), null, `"${invalid}" deveria ser inválido`);
  }
});

test('stillMatches só aceita mesmo papel E mesmo nome', () => {
  const entries = entriesOf(flatten(page).nodes);
  assert.equal(entries[4]?.role, 'button');

  assert.equal(stillMatches(entries[4], { role: 'button', name: 'Enviar' }), true);
  // A página trocou o rótulo do botão: recusar é o comportamento certo.
  assert.equal(stillMatches(entries[4], { role: 'button', name: 'Cancelar' }), false);
  // Mesmo nome, papel diferente: também não é o mesmo elemento.
  assert.equal(stillMatches(entries[4], { role: 'link', name: 'Enviar' }), false);
  assert.equal(stillMatches(entries[4], undefined), false);
  assert.equal(stillMatches(undefined, { role: 'button', name: 'Enviar' }), false);
});

test('nó sem nome equivale a nome vazio', () => {
  const entries = entriesOf(flatten({ role: 'generic' }).nodes);
  assert.deepEqual(entries, [{ role: 'generic', name: '' }]);
  assert.equal(stillMatches(entries[0], { role: 'generic' }), true);
});
