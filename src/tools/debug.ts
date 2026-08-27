// Depuração: console, rede e execução de script na página.

import { z } from 'zod';

import { filterNetworkEntries, mergeNetworkEntries } from '../browser/network.ts';
import { type ToolModule, json, launchNote, text, withNote, withPage } from './helpers.ts';

const pageIdParam = z
  .string()
  .optional()
  .describe('Id da aba (ex.: "page_0"). Sem isto, usa a aba selecionada.');

/** Formata o instante como hora local legível, mantendo o epoch para ordenar. */
function at(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export const debugTools: ToolModule = (server, ctx) => {
  server.registerTool(
    'list_console_messages',
    {
      title: 'Mensagens do console',
      description:
        'Lista o que a página escreveu no console, incluindo erros de JavaScript e ' +
        'promises rejeitadas. O histórico ATRAVESSA navegações: o que foi logado ' +
        'antes de um navigate_page continua aqui. Também mostra os diálogos ' +
        '(alert/confirm/prompt) que apareceram e como foram respondidos.',
      inputSchema: {
        pageId: pageIdParam,
        types: z
          .array(z.enum(['log', 'info', 'warn', 'error', 'debug', 'pageerror', 'unhandledrejection']))
          .optional()
          .describe('Filtra por tipo. Sem isto, traz todos.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Quantas mensagens trazer, das mais recentes para trás.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pageId, types, limit }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id }) => {
        const wanted = types?.length ? new Set(types) : null;
        const all = await handle.consoleEntries(id);
        const filtered = wanted ? all.filter((entry) => wanted.has(entry.type as never)) : all;
        const recent = filtered.slice(Math.max(0, filtered.length - limit));
        const dialogs = await handle.dialogEntries(id);

        return withNote(
          json({
            aba: id,
            total_guardado: all.length,
            mostrando: recent.length,
            mensagens: recent.map((entry) => ({
              tipo: entry.type,
              texto: entry.text,
              em: at(entry.at),
              ...(entry.stack ? { stack: entry.stack } : {}),
            })),
            ...(dialogs.length
              ? {
                  dialogos: dialogs.map((dialog) => ({
                    tipo: dialog.kind,
                    mensagem: dialog.message,
                    resposta: dialog.handledAs,
                    em: at(dialog.at),
                  })),
                }
              : {}),
          }),
          launchNote(handle, ctx.config)
        );
      })
  );

  server.registerTool(
    'list_network_requests',
    {
      title: 'Requisições de rede',
      description:
        'Lista as requisições que a página fez — documento, imagens, scripts, fetch ' +
        'e XHR — com método, status, duração e bytes quando disponíveis. Assim como ' +
        'o console, o histórico sobrevive às navegações. Use onlyFailures para ir ' +
        'direto ao que quebrou.',
      inputSchema: {
        pageId: pageIdParam,
        urlContains: z.string().optional().describe('Filtra por trecho da URL.'),
        onlyFailures: z
          .boolean()
          .default(false)
          .describe('true traz só status >= 400 e requisições sem resposta.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Quantas requisições trazer, das mais recentes para trás.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pageId, urlContains, onlyFailures, limit }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id }) => {
        const merged = mergeNetworkEntries(await handle.networkEntries(id));
        const filtered = filterNetworkEntries(merged, { urlContains, onlyFailures });
        const recent = filtered.slice(Math.max(0, filtered.length - limit));

        return withNote(
          json({
            aba: id,
            total_guardado: merged.length,
            mostrando: recent.length,
            requisicoes: recent.map((entry) => ({
              metodo: entry.method ?? null,
              status: entry.status ?? null,
              url: entry.url,
              tipo: entry.type ?? null,
              ms: entry.ms ?? null,
              bytes: entry.bytes ?? null,
              em: at(entry.at),
            })),
            observacao:
              'Os dados vêm de dentro da página (PerformanceObserver + patches de ' +
              'fetch/XHR). Corpo de requisição e resposta não são capturados.',
          }),
          launchNote(handle, ctx.config)
        );
      })
  );

  server.registerTool(
    'evaluate_script',
    {
      title: 'Executar script',
      description:
        'Executa JavaScript dentro da página e devolve o resultado. Aceite uma ' +
        'função (`() => document.title`, `(a, b) => a + b`) ou uma expressão solta ' +
        '(`document.title`). Promises são aguardadas. O retorno precisa ser ' +
        'serializável em JSON — devolver um elemento do DOM não funciona; devolva ' +
        'as propriedades dele. É a saída de emergência para o que as outras ' +
        'ferramentas não cobrem.',
      inputSchema: {
        pageId: pageIdParam,
        function: z
          .string()
          .min(1)
          .describe('Função ou expressão JavaScript, como texto.'),
        args: z
          .array(z.unknown())
          .default([])
          .describe('Argumentos passados à função, quando o script for uma função.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ pageId, function: source, args }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id, page }) => {
        // Montado como texto e avaliado DENTRO do navegador. Nada disso passa
        // por eval no Worker — o runtime dos Workers proíbe geração dinâmica de
        // código, e é o Chromium remoto que compila esta string.
        const expression =
          `(() => { const __mcpFn = (${source}); ` +
          `return typeof __mcpFn === 'function' ? __mcpFn.apply(null, ${JSON.stringify(
            args ?? []
          )}) : __mcpFn; })()`;

        const result = await page.evaluate(expression);
        // Script que mexe no DOM invalida os índices do snapshot.
        await handle.invalidateSnapshot(id);

        if (result === undefined) {
          return withNote(
            text(
              'O script rodou e devolveu `undefined`. Se esperava um valor, ' +
                'confira se ele tem `return` (ou se é uma expressão).'
            ),
            launchNote(handle, ctx.config)
          );
        }
        return withNote(json(result), launchNote(handle, ctx.config));
      })
  );
};
