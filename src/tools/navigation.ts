// Navegação e ciclo de vida das abas.

import { z } from 'zod';

import { type ToolModule, json, launchNote, text, withNote, withPage } from './helpers.ts';
import { guard } from './helpers.ts';

const pageIdParam = z
  .string()
  .optional()
  .describe('Id da aba (ex.: "page_0"). Sem isto, usa a aba selecionada.');

export const navigationTools: ToolModule = (server, ctx) => {
  server.registerTool(
    'list_pages',
    {
      title: 'Listar abas',
      description:
        'Lista as abas abertas no navegador remoto, com id, URL e título, e marca ' +
        'qual está selecionada. Os ids são o que as outras ferramentas aceitam em ' +
        '`pageId`. Se ainda não houver sessão de navegador, esta ferramenta abre uma ' +
        '(e isso já consome orçamento).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(() =>
        ctx.run(async (handle) => {
          const pages = await handle.listPages();
          return withNote(
            json({ abas: pages, limite: ctx.config.maxPages }),
            launchNote(handle, ctx.config)
          );
        })
      )
  );

  server.registerTool(
    'new_page',
    {
      title: 'Abrir aba',
      description:
        'Abre uma aba nova e navega até a URL informada. A aba criada vira a ' +
        'selecionada. O número de abas simultâneas é limitado por configuração — ' +
        'todas dividem a memória do mesmo Chromium, e abas demais derrubam a sessão.',
      inputSchema: {
        url: z.string().describe('URL completa, com esquema (https://...).'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ url }) =>
      guard(() =>
        ctx.run(async (handle) => {
          const { id, page } = await handle.newPage(url);
          return withNote(
            json({ aba: id, url: page.url(), titulo: await page.title().catch(() => '') }),
            launchNote(handle, ctx.config)
          );
        })
      )
  );

  server.registerTool(
    'select_page',
    {
      title: 'Selecionar aba',
      description:
        'Define qual aba as demais ferramentas usam quando `pageId` é omitido. ' +
        'Útil quando um clique abriu uma aba nova (target=_blank) e o trabalho ' +
        'continua nela: em vez de repetir o pageId em toda chamada, selecione a aba ' +
        'uma vez. Selecionar NÃO traz a aba para a frente no navegador — para o ' +
        'Chromium headless, o que existe é o alvo de cada comando.',
      inputSchema: { pageId: z.string().describe('Id da aba, vindo de list_pages.') },
      annotations: { readOnlyHint: false },
    },
    async ({ pageId }) =>
      guard(() =>
        ctx.run(async (handle) => {
          const { id, page } = await handle.page(pageId);
          await handle.select(id);
          return text(`Aba selecionada: ${id} (${page.url()}).`);
        })
      )
  );

  server.registerTool(
    'close_page',
    {
      title: 'Fechar aba',
      description:
        'Fecha uma aba e descarta o histórico de console/rede dela. Fechar abas que ' +
        'não estão em uso libera memória do Chromium, mas NÃO encerra a sessão de ' +
        'navegador — para parar o relógio do custo, use close_browser_session.',
      inputSchema: { pageId: z.string().describe('Id da aba a fechar.') },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ pageId }) =>
      guard(() =>
        ctx.run(async (handle) => {
          await handle.closePage(pageId);
          const remaining = await handle.listPages();
          return json({ fechada: pageId, abas_restantes: remaining.map((p) => p.id) });
        })
      )
  );

  server.registerTool(
    'navigate_page',
    {
      title: 'Navegar',
      description:
        'Navega a aba: para uma URL nova, ou no histórico (voltar/avançar), ou ' +
        'recarregando. O console e a rede acumulados antes da navegação são ' +
        'preservados — list_console_messages continua mostrando o que aconteceu antes.',
      inputSchema: {
        pageId: pageIdParam,
        url: z
          .string()
          .optional()
          .describe('URL de destino. Obrigatório quando type é "url" (o padrão).'),
        type: z
          .enum(['url', 'back', 'forward', 'reload'])
          .default('url')
          .describe('O tipo de navegação.'),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])
          .default('load')
          .describe(
            'Quando considerar a navegação pronta. "networkidle0" espera a rede ' +
              'sossegar — mais confiável em SPA, mais lento e mais caro.'
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ pageId, url, type, waitUntil }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id, page }) => {
        const options = { timeout: ctx.config.timeoutMs, waitUntil };

        if (type === 'url') {
          if (!url) {
            return { ...text('Faltou a URL para navigate_page com type "url".'), isError: true };
          }
          await handle.goto(page, url, waitUntil);
        } else if (type === 'back') {
          const result = await page.goBack(options);
          if (!result) return text('Não há página anterior no histórico desta aba.');
        } else if (type === 'forward') {
          const result = await page.goForward(options);
          if (!result) return text('Não há próxima página no histórico desta aba.');
        } else {
          await page.reload(options);
        }

        // O snapshot antigo não vale mais nada depois de trocar de documento.
        await handle.invalidateSnapshot(id);
        await handle.ensureCollector(page);

        return withNote(
          json({ aba: id, url: page.url(), titulo: await page.title().catch(() => '') }),
          launchNote(handle, ctx.config)
        );
      })
  );

  server.registerTool(
    'resize_page',
    {
      title: 'Redimensionar viewport',
      description:
        'Muda a largura e a altura da viewport da aba — útil para checar layout ' +
        'responsivo antes de tirar um screenshot. Vale só para o tamanho da janela; ' +
        'não emula toque, user agent nem densidade de tela.',
      inputSchema: {
        pageId: pageIdParam,
        width: z.number().int().min(200).max(3840).describe('Largura em pixels CSS.'),
        height: z.number().int().min(200).max(2160).describe('Altura em pixels CSS.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ pageId, width, height }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id, page }) => {
        await page.setViewport({ width, height });
        // Mudar a viewport reflui a página: os índices do snapshot podem andar.
        await handle.invalidateSnapshot(id);
        return text(`Viewport da aba ${id} agora é ${width}x${height}.`);
      })
  );
};
