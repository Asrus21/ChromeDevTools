// O coletor roda dentro da página, e por isso é uma string: nada de tsc nem de
// bundler o revisa. Aqui ele é executado num contexto isolado do Node, com um
// `window` de mentira, para provar que compila e que faz o que promete.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import vm from 'node:vm';

import { COLLECTOR_DRAIN_SOURCE, collectorInstallSource } from '../src/browser/collector.ts';

interface FakeWindow {
  __mcpCollector?: { console: unknown[]; network: unknown[]; dialogs: unknown[] };
  addEventListener(type: string, handler: (event: unknown) => void): void;
  alert(message?: unknown): void;
  confirm(message?: unknown): boolean;
  prompt(message?: unknown, fallback?: string): string | null;
  fetch?: (...args: unknown[]) => Promise<{ status: number }>;
  [key: string]: unknown;
}

/** Um "navegador" mínimo: só o que o script do coletor toca. */
function makeBrowser(): {
  context: vm.Context;
  window: FakeWindow;
  logs: unknown[][];
  listeners: Map<string, ((event: unknown) => void)[]>;
  observed: string[];
} {
  const logs: unknown[][] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const observed: string[] = [];

  const sandbox: Record<string, unknown> = {};
  sandbox.console = {
    log: (...args: unknown[]) => logs.push(args),
    info: (...args: unknown[]) => logs.push(args),
    warn: (...args: unknown[]) => logs.push(args),
    error: (...args: unknown[]) => logs.push(args),
    debug: (...args: unknown[]) => logs.push(args),
  };
  sandbox.PerformanceObserver = class {
    constructor(_callback: unknown) {}
    observe(options: { type: string }): void {
      observed.push(options.type);
    }
  };
  sandbox.addEventListener = (type: string, handler: (event: unknown) => void): void => {
    listeners.set(type, [...(listeners.get(type) ?? []), handler]);
  };
  // Num navegador, `window` é o próprio objeto global.
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  return { context, window: sandbox as unknown as FakeWindow, logs, listeners, observed };
}

function run(context: vm.Context, source: string): unknown {
  return vm.runInContext(source, context);
}

test('os scripts do coletor são JavaScript válido', () => {
  // Compilar sem executar já pega qualquer erro de sintaxe na string.
  assert.doesNotThrow(() => new vm.Script(collectorInstallSource('dismiss')));
  assert.doesNotThrow(() => new vm.Script(COLLECTOR_DRAIN_SOURCE));
});

test('instalar é idempotente', () => {
  const browser = makeBrowser();
  const source = collectorInstallSource('dismiss');
  assert.equal(run(browser.context, source), 'installed');
  // Registramos o script também via evaluateOnNewDocument, então ele roda de
  // novo a cada navegação — reinstalar não pode duplicar patch nenhum.
  assert.equal(run(browser.context, source), 'already');
});

test('o console é capturado sem parar de funcionar', () => {
  const browser = makeBrowser();
  run(browser.context, collectorInstallSource('dismiss'));

  run(browser.context, 'console.log("oi", { a: 1 })');
  run(browser.context, 'console.error("quebrou")');

  const captured = browser.window.__mcpCollector!.console as { type: string; text: string }[];
  assert.equal(captured.length, 2);
  assert.equal(captured[0]?.type, 'log');
  assert.equal(captured[0]?.text, 'oi {"a":1}');
  assert.equal(captured[1]?.type, 'error');
  // O console original continua recebendo: não roubamos a saída da página.
  assert.equal(browser.logs.length, 2);
});

test('erro de página e promise rejeitada entram no mesmo histórico', () => {
  const browser = makeBrowser();
  run(browser.context, collectorInstallSource('dismiss'));

  browser.listeners.get('error')?.[0]?.({
    message: 'x is not defined',
    error: { stack: 'ReferenceError: x is not defined\n  at <anonymous>' },
  });
  browser.listeners.get('unhandledrejection')?.[0]?.({ reason: 'falhou' });

  const captured = browser.window.__mcpCollector!.console as { type: string; stack?: string }[];
  // O spread traz o array para o realm do teste: valores vindos do `vm` têm
  // outro Array.prototype, e deepStrictEqual compara protótipos.
  assert.deepEqual(
    [...captured.map((entry) => entry.type)],
    ['pageerror', 'unhandledrejection']
  );
  assert.match(captured[0]?.stack ?? '', /ReferenceError/);
});

test('observa rede de recursos e de navegação', () => {
  const browser = makeBrowser();
  run(browser.context, collectorInstallSource('dismiss'));
  assert.deepEqual(browser.observed, ['resource', 'navigation']);
});

test('fetch é instrumentado e continua devolvendo a resposta', async () => {
  const browser = makeBrowser();
  const sandbox = browser.window;
  sandbox.fetch = async () => ({ status: 201 });
  run(browser.context, collectorInstallSource('dismiss'));

  const response = await (sandbox.fetch as (...args: unknown[]) => Promise<{ status: number }>)(
    'https://exemplo/api',
    { method: 'post' }
  );
  assert.equal(response.status, 201, 'a página precisa receber a resposta original');

  const captured = browser.window.__mcpCollector!.network as {
    url: string;
    method: string;
    status: number;
    via: string;
  }[];
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.method, 'POST');
  assert.equal(captured[0]?.status, 201);
  assert.equal(captured[0]?.via, 'fetch');
});

test('diálogos são respondidos e registrados — dismiss', () => {
  const browser = makeBrowser();
  run(browser.context, collectorInstallSource('dismiss'));

  browser.window.alert('atenção');
  assert.equal(browser.window.confirm('tem certeza?'), false);
  assert.equal(browser.window.prompt('nome?', 'padrão'), null);

  const dialogs = browser.window.__mcpCollector!.dialogs as {
    kind: string;
    handledAs: string;
  }[];
  assert.deepEqual(
    [...dialogs.map((d) => `${d.kind}:${d.handledAs}`)],
    ['alert:dismissed', 'confirm:dismissed', 'prompt:dismissed']
  );
});

test('diálogos são respondidos e registrados — accept', () => {
  const browser = makeBrowser();
  run(browser.context, collectorInstallSource('accept'));

  assert.equal(browser.window.confirm('tem certeza?'), true);
  assert.equal(browser.window.prompt('nome?', 'padrão'), 'padrão');
});

test('o buffer da página descarta as entradas antigas', () => {
  const browser = makeBrowser();
  run(browser.context, collectorInstallSource('dismiss', 3));

  for (let i = 0; i < 5; i++) run(browser.context, `console.log("m${i}")`);

  const captured = browser.window.__mcpCollector!.console as { text: string }[];
  assert.equal(captured.length, 3);
  assert.deepEqual(
    [...captured.map((entry) => entry.text)],
    ['m2', 'm3', 'm4']
  );
});

test('drenar devolve o conteúdo e esvazia', () => {
  const browser = makeBrowser();
  run(browser.context, collectorInstallSource('dismiss'));
  run(browser.context, 'console.log("antes")');

  const drained = run(browser.context, COLLECTOR_DRAIN_SOURCE) as {
    console: { text: string }[];
  };
  assert.equal(drained.console.length, 1);
  assert.equal(drained.console[0]?.text, 'antes');

  // Esvaziado: a próxima drenagem não pode repetir o que já foi guardado.
  const again = run(browser.context, COLLECTOR_DRAIN_SOURCE) as { console: unknown[] };
  assert.equal(again.console.length, 0);

  // E o coletor continua funcionando depois de drenado.
  run(browser.context, 'console.log("depois")');
  const third = run(browser.context, COLLECTOR_DRAIN_SOURCE) as { console: { text: string }[] };
  assert.equal(third.console[0]?.text, 'depois');
});

test('drenar sem coletor instalado devolve null', () => {
  const browser = makeBrowser();
  assert.equal(run(browser.context, COLLECTOR_DRAIN_SOURCE), null);
});
