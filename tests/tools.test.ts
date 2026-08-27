// As ferramentas são o contrato com o Claude. Este teste sobe um servidor MCP
// de verdade em memória, conecta um cliente MCP de verdade e conversa com ele
// — sem navegador nenhum. Se um schema estiver quebrado ou um nome mudar, ele
// falha aqui, não no meio de uma sessão.

import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { readConfig } from '../src/config.ts';
import { registerAllTools } from '../src/tools/index.ts';
import type { ToolContext } from '../src/tools/helpers.ts';

/** Toda ferramenta que a v1 promete. Mudou aqui, mudou o README. */
const EXPECTED_TOOLS = [
  'browser_status',
  'click',
  'close_browser_session',
  'close_page',
  'evaluate_script',
  'fill',
  'fill_form',
  'hover',
  'list_console_messages',
  'list_network_requests',
  'list_pages',
  'navigate_page',
  'new_page',
  'press_key',
  'resize_page',
  'select_page',
  'take_screenshot',
  'take_snapshot',
  'type_text',
  'wait_for',
];

const config = readConfig({});

/** Sessão de mentira: registra o que foi chamado e nunca abre navegador. */
const calls: string[] = [];
const fakeSession = {
  async status() {
    calls.push('status');
    return {
      sessionId: null,
      pages: 0,
      budget: {
        day: '2026-08-27',
        usedSeconds: 12,
        budgetSeconds: 480,
        remainingSeconds: 468,
        openSessions: 0,
      },
      limits: { active: 0, max: 3, allowedNow: 3 },
    };
  },
  async close() {
    calls.push('close');
    return { closed: false, spentSeconds: 0 };
  },
  budget: {
    async report() {
      return {
        day: '2026-08-27',
        usedSeconds: 12,
        budgetSeconds: 480,
        remainingSeconds: 468,
        openSessions: 0,
      };
    },
  },
};

const ctx: ToolContext = {
  config,
  session: fakeSession as unknown as ToolContext['session'],
  async run() {
    calls.push('run');
    throw new Error('nenhum teste deve abrir navegador');
  },
};

const client = new Client({ name: 'teste', version: '1.0.0' });

before(async () => {
  const server = new McpServer({ name: 'chrome-devtools-mcp-worker', version: '1.0.0' });
  registerAllTools(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
});

test('todas as ferramentas da v1 estão registradas, e só elas', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    EXPECTED_TOOLS
  );
});

test('toda ferramenta tem descrição e schema de objeto válido', async () => {
  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} sem descrição`);
    assert.ok(
      (tool.description?.length ?? 0) > 80,
      `${tool.name}: a descrição precisa dizer QUANDO usar, não só o que faz`
    );
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} com schema inválido`);
    assert.ok(tool.annotations, `${tool.name} sem annotations`);
  }
});

test('as ferramentas de leitura estão marcadas como readOnly', async () => {
  const { tools } = await client.listTools();
  const readOnly = tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .map((tool) => tool.name)
    .sort();

  assert.deepEqual(readOnly, [
    'browser_status',
    'list_console_messages',
    'list_network_requests',
    'list_pages',
    'take_screenshot',
    'take_snapshot',
    'wait_for',
  ]);
});

test('as ferramentas de interação exigem uid', async () => {
  const { tools } = await client.listTools();
  for (const name of ['click', 'hover', 'fill']) {
    const tool = tools.find((candidate) => candidate.name === name)!;
    const required = (tool.inputSchema.required ?? []) as string[];
    assert.ok(required.includes('uid'), `${name} deveria exigir uid`);
    assert.ok(
      !required.includes('pageId'),
      `${name}: pageId é opcional, para o modelo não precisar rastrear a aba`
    );
  }
});

test('browser_status responde sem abrir navegador', async () => {
  calls.length = 0;
  const result = await client.callTool({ name: 'browser_status', arguments: {} });

  assert.equal(result.isError, undefined);
  const payload = JSON.parse((result.content as { text: string }[])[0]!.text);
  assert.equal(payload.sessao_aberta, false);
  assert.equal(payload.orcamento.restante_segundos, 468);
  assert.deepEqual(calls, ['status'], 'não pode ter chamado run(), que abriria o Chromium');
});

test('close_browser_session é seguro quando não há sessão', async () => {
  calls.length = 0;
  const result = await client.callTool({ name: 'close_browser_session', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.match((result.content as { text: string }[])[0]!.text, /Não havia sessão/);
  assert.deepEqual(calls, ['close']);
});

test('erro de ferramenta vira isError, não exceção de protocolo', async () => {
  // O `run` de mentira sempre falha: é o caminho de qualquer ferramenta que
  // toca o navegador. O cliente MCP tem que receber isso como resultado.
  const result = await client.callTool({ name: 'list_pages', arguments: {} });
  assert.equal(result.isError, true);
  assert.match((result.content as { text: string }[])[0]!.text, /Erro inesperado/);
});

test('argumento inválido é recusado pelo schema', async () => {
  const result = await client.callTool({
    name: 'resize_page',
    arguments: { width: 10, height: 600 },
  });
  assert.equal(result.isError, true, 'largura abaixo do mínimo tinha que ser recusada');
});
