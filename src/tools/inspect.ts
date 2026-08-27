// Inspeção: a árvore de acessibilidade e o screenshot.

import { z } from 'zod';

import { DEFAULT_MAX_NODES } from '../browser/snapshot.ts';
import { type ToolModule, image, launchNote, text, withNote, withPage } from './helpers.ts';

/**
 * Teto do base64 devolvido num screenshot. Acima disso a resposta MCP fica
 * pesada o bastante para atrapalhar mais do que a imagem ajuda — melhor
 * recomprimir e avisar do que entregar um bloco gigante.
 */
const MAX_IMAGE_BASE64 = 1_000_000;

const pageIdParam = z
  .string()
  .optional()
  .describe('Id da aba (ex.: "page_0"). Sem isto, usa a aba selecionada.');

export const inspectTools: ToolModule = (server, ctx) => {
  server.registerTool(
    'take_snapshot',
    {
      title: 'Snapshot de acessibilidade',
      description:
        'Devolve a árvore de acessibilidade da página — papel, nome acessível e ' +
        'estado de cada elemento, do mesmo jeito que um leitor de tela enxerga. ' +
        'É a ferramenta de leitura preferida: mais barata e mais estável que um ' +
        'screenshot, e é ela que gera os `uid` usados por click, fill e hover. ' +
        'Cada snapshot invalida os uids do anterior; tire um novo depois de ' +
        'qualquer coisa que mude a página.',
      inputSchema: {
        pageId: pageIdParam,
        verbose: z
          .boolean()
          .default(false)
          .describe(
            'true traz a árvore inteira, inclusive nós que o Chrome considera ' +
              'irrelevantes. Muito maior; use só quando o elemento procurado não ' +
              'aparecer no snapshot normal.'
          ),
        maxNodes: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .default(DEFAULT_MAX_NODES)
          .describe('Teto de nós antes de truncar.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pageId, verbose, maxNodes }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id, page }) => {
        const snapshot = await handle.takeSnapshot(id, page, { verbose, maxNodes });
        return withNote(text(snapshot), launchNote(handle, ctx.config));
      })
  );

  server.registerTool(
    'take_screenshot',
    {
      title: 'Screenshot',
      description:
        'Captura a página como imagem. Use quando a pergunta for visual (layout ' +
        'quebrado, cor, sobreposição); para ler conteúdo ou achar um elemento para ' +
        'clicar, take_snapshot é melhor e mais barato. O padrão é JPEG, que gera ' +
        'uma resposta bem menor que PNG.',
      inputSchema: {
        pageId: pageIdParam,
        fullPage: z
          .boolean()
          .default(false)
          .describe('true captura a página inteira rolando, não só a viewport.'),
        format: z.enum(['jpeg', 'png', 'webp']).default('jpeg').describe('Formato da imagem.'),
        quality: z
          .number()
          .int()
          .min(10)
          .max(100)
          .default(70)
          .describe('Qualidade 10–100. Ignorado quando o formato é png.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pageId, fullPage, format, quality }) =>
      withPage(ctx, pageId, async ({ handle, page }) => {
        const capture = async (
          type: 'jpeg' | 'png' | 'webp',
          q: number
        ): Promise<string> =>
          page.screenshot({
            type,
            fullPage,
            encoding: 'base64',
            ...(type === 'png' ? {} : { quality: q }),
          });

        let type = format;
        let data = await capture(type, quality);

        // Grande demais: uma recompressão em JPEG costuma resolver sem perder
        // o que interessa. Se nem isso couber, é melhor dizer o porquê.
        if (data.length > MAX_IMAGE_BASE64 && type !== 'jpeg') {
          type = 'jpeg';
          data = await capture(type, Math.min(quality, 60));
        }
        if (data.length > MAX_IMAGE_BASE64) {
          const retry = await capture('jpeg', 35);
          if (retry.length > MAX_IMAGE_BASE64) {
            return {
              ...text(
                `O screenshot ficou grande demais (${Math.round(retry.length / 1024)} KB ` +
                  `em base64) mesmo recomprimido.` +
                  (fullPage
                    ? ' Tente sem fullPage, ou reduza a viewport com resize_page.'
                    : ' Reduza a viewport com resize_page.')
              ),
              isError: true,
            };
          }
          data = retry;
          type = 'jpeg';
        }

        const note = launchNote(handle, ctx.config);
        const caption =
          `${page.url()} — ${type}, ${Math.round(data.length / 1024)} KB` +
          (fullPage ? ', página inteira' : ', viewport');
        return withNote(image(data, `image/${type}`, caption), note);
      })
  );
};
