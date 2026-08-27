// Interação: clicar, preencher, digitar, esperar.
//
// Todas estas ferramentas trabalham com `uid` vindo do take_snapshot, não com
// seletor CSS. O motivo está em src/browser/snapshot.ts: o uid é validado
// contra a árvore viva antes de qualquer ação, então uma página que mudou
// devolve um erro claro em vez de um clique no elemento errado.

import { z } from 'zod';
import type { ElementHandle, KeyInput, Page } from '@cloudflare/puppeteer';

import { BrowserToolError } from '../browser/errors.ts';
import { type ToolModule, json, launchNote, text, withNote, withPage } from './helpers.ts';

const pageIdParam = z
  .string()
  .optional()
  .describe('Id da aba (ex.: "page_0"). Sem isto, usa a aba selecionada.');

const uidParam = z
  .string()
  .describe('uid do elemento, exatamente como veio do take_snapshot (ex.: "1_42").');

/** Papéis que se preenchem digitando. */
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider']);
/** Papéis que se preenchem escolhendo uma opção. */
const CHOICE_ROLES = new Set(['combobox', 'listbox', 'menu', 'menulistbox']);
/** Papéis que se alternam com um clique. */
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

/**
 * Preenche um elemento de acordo com o PAPEL dele na árvore de acessibilidade.
 *
 * O papel é o que temos sem inspecionar o DOM — e inspecionar o DOM exigiria
 * um callback tipado rodando dentro da página, coisa que este projeto evita
 * de propósito (ver o cabeçalho de src/browser/session.ts).
 */
async function fillByRole(
  page: Page,
  element: ElementHandle,
  role: string,
  value: string
): Promise<string> {
  if (CHOICE_ROLES.has(role)) {
    try {
      const selected = await element.select(value);
      if (selected.length > 0) return `opção "${value}" selecionada`;
    } catch {
      // Não era um <select> de verdade (combobox de biblioteca, por exemplo):
      // cai no caminho de digitar, que funciona nos autocompletes comuns.
    }
  }

  if (TOGGLE_ROLES.has(role)) {
    await element.click();
    return 'estado alternado com um clique (papéis de marcar/desmarcar ignoram o valor)';
  }

  // Caminho padrão — inclusive para papéis fora de TEXT_ROLES, porque digitar
  // é o que mais perto chega de "preencher" num elemento desconhecido.
  // Um clique triplo seleciona o conteúdo atual; sem ele, digitar concatenaria.
  await element.click({ count: 3 });
  await page.keyboard.press('Backspace');
  if (value) await element.type(value);
  const known = TEXT_ROLES.has(role) ? '' : ` (papel "${role}" tratado como campo de texto)`;
  return `preenchido com ${JSON.stringify(value)}${known}`;
}

/** "Control+A" vira segurar Control, apertar A, soltar Control. */
async function pressCombo(page: Page, combo: string): Promise<void> {
  const parts = combo
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new BrowserToolError('Combinação de teclas vazia.');

  const key = parts.pop() as KeyInput;
  const modifiers = parts as KeyInput[];
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  try {
    await page.keyboard.press(key);
  } finally {
    for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier);
  }
}

export const interactTools: ToolModule = (server, ctx) => {
  server.registerTool(
    'click',
    {
      title: 'Clicar',
      description:
        'Clica em um elemento identificado pelo uid do último take_snapshot. ' +
        'Se a página tiver mudado desde o snapshot, a ferramenta recusa em vez de ' +
        'clicar no lugar errado — nesse caso tire outro snapshot.',
      inputSchema: {
        pageId: pageIdParam,
        uid: uidParam,
        dblClick: z.boolean().default(false).describe('true dá um duplo clique.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ pageId, uid, dblClick }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id, page }) => {
        const label = await handle.describeUid(id, uid);
        const element = await handle.resolveUid(id, page, uid);
        try {
          await element.click(dblClick ? { count: 2 } : {});
        } finally {
          await element.dispose().catch(() => {});
        }
        return withNote(
          text(
            `${dblClick ? 'Duplo clique' : 'Clique'} em ${label}. URL agora: ${page.url()}`
          ),
          launchNote(handle, ctx.config)
        );
      })
  );

  server.registerTool(
    'hover',
    {
      title: 'Passar o mouse',
      description:
        'Posiciona o cursor sobre um elemento — é assim que se abre menu suspenso ' +
        'ou tooltip que só aparece no hover. Tire um snapshot depois para ver o que surgiu.',
      inputSchema: { pageId: pageIdParam, uid: uidParam },
      annotations: { readOnlyHint: false },
    },
    async ({ pageId, uid }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id, page }) => {
        const label = await handle.describeUid(id, uid);
        const element = await handle.resolveUid(id, page, uid);
        try {
          await element.hover();
        } finally {
          await element.dispose().catch(() => {});
        }
        return text(`Cursor sobre ${label}.`);
      })
  );

  server.registerTool(
    'fill',
    {
      title: 'Preencher campo',
      description:
        'Preenche um campo de formulário. A ação depende do papel do elemento no ' +
        'snapshot: campo de texto é limpo e digitado, combobox tenta selecionar a ' +
        'opção pelo valor, checkbox/radio são alternados com um clique.',
      inputSchema: {
        pageId: pageIdParam,
        uid: uidParam,
        value: z.string().describe('Valor a escrever, ou a opção a selecionar.'),
        submit: z
          .boolean()
          .default(false)
          .describe('true aperta Enter no fim, enviando o formulário.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ pageId, uid, value, submit }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id, page }) => {
        const label = await handle.describeUid(id, uid);
        const entry = await handle.entryOfUid(id, uid);
        const element = await handle.resolveUid(id, page, uid);
        let outcome: string;
        try {
          outcome = await fillByRole(page, element, entry?.role ?? 'textbox', value);
          if (submit) await page.keyboard.press('Enter');
        } finally {
          await element.dispose().catch(() => {});
        }
        return text(`${label}: ${outcome}` + (submit ? ', e Enter enviado.' : '.'));
      })
  );

  server.registerTool(
    'fill_form',
    {
      title: 'Preencher formulário',
      description:
        'Preenche vários campos de uma vez, na ordem informada. Uma chamada só em ' +
        'vez de N — cada ida ao navegador remoto custa latência. Se um campo falhar, ' +
        'os anteriores continuam preenchidos e a resposta diz onde parou.',
      inputSchema: {
        pageId: pageIdParam,
        fields: z
          .array(
            z.object({
              uid: uidParam,
              value: z.string().describe('Valor do campo.'),
            })
          )
          .min(1)
          .max(30)
          .describe('Campos a preencher, na ordem.'),
        submit: z.boolean().default(false).describe('true aperta Enter no fim.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ pageId, fields, submit }) =>
      withPage(ctx, pageId, async ({ handle, pageId: id, page }) => {
        const done: string[] = [];
        for (const field of fields) {
          const entry = await handle.entryOfUid(id, field.uid);
          const element = await handle.resolveUid(id, page, field.uid);
          try {
            const outcome = await fillByRole(page, element, entry?.role ?? 'textbox', field.value);
            done.push(`${field.uid}: ${outcome}`);
          } catch (err) {
            done.push(`${field.uid}: FALHOU — ${err instanceof Error ? err.message : String(err)}`);
            return { ...json({ preenchidos: done }), isError: true };
          } finally {
            await element.dispose().catch(() => {});
          }
        }
        if (submit) await page.keyboard.press('Enter');
        return json({ preenchidos: done, enviado: submit });
      })
  );

  server.registerTool(
    'type_text',
    {
      title: 'Digitar',
      description:
        'Digita no elemento que está com o foco, sem precisar de uid. Serve para ' +
        'campos que já receberam foco (depois de um click) e para atalhos de página. ' +
        'Para preencher um campo específico, prefira fill.',
      inputSchema: {
        pageId: pageIdParam,
        text: z.string().describe('Texto a digitar.'),
        submitKey: z
          .enum(['none', 'Enter', 'Tab'])
          .default('none')
          .describe('Tecla apertada depois do texto.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ pageId, text: value, submitKey }) =>
      withPage(ctx, pageId, async ({ page }) => {
        await page.keyboard.type(value);
        if (submitKey !== 'none') await page.keyboard.press(submitKey);
        return text(
          `Digitado ${JSON.stringify(value)}` +
            (submitKey === 'none' ? '.' : ` e ${submitKey} apertado.`)
        );
      })
  );

  server.registerTool(
    'press_key',
    {
      title: 'Apertar tecla',
      description:
        'Aperta uma tecla ou combinação na página, como "Enter", "Escape", ' +
        '"ArrowDown" ou "Control+A". Os nomes são os do DOM (KeyboardEvent.key).',
      inputSchema: {
        pageId: pageIdParam,
        key: z.string().describe('Tecla ou combinação, ex.: "Enter", "Control+A".'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ pageId, key }) =>
      withPage(ctx, pageId, async ({ page }) => {
        await pressCombo(page, key);
        return text(`Tecla ${key} apertada.`);
      })
  );

  server.registerTool(
    'wait_for',
    {
      title: 'Esperar texto',
      description:
        'Bloqueia até um trecho de texto aparecer na página, ou até estourar o ' +
        'tempo. Use depois de uma ação que dispara carregamento assíncrono, em vez ' +
        'de tirar snapshots repetidos — cada snapshot é uma ida ao navegador remoto.',
      inputSchema: {
        pageId: pageIdParam,
        text: z
          .string()
          .min(1)
          .describe('Trecho de texto a aguardar (busca exata, sensível a caixa).'),
        timeout: z
          .number()
          .int()
          .min(500)
          .max(60_000)
          .optional()
          .describe('Tempo máximo em ms. O padrão vem da configuração do servidor.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pageId, text: needle, timeout }) =>
      withPage(ctx, pageId, async ({ page }) => {
        // Expressão como string, e não callback: o tsconfig do Worker não tem a
        // lib DOM, então `document` não existe do lado de cá (ver session.ts).
        const expression = `!!document.body && document.body.innerText.includes(${JSON.stringify(
          needle
        )})`;
        await page.waitForFunction(expression, {
          timeout: timeout ?? ctx.config.timeoutMs,
          polling: 250,
        });
        return text(`Texto ${JSON.stringify(needle)} apareceu na página.`);
      })
  );
};
