// Utilidades compartilhadas pelos módulos de ferramentas.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from '@cloudflare/puppeteer';

import type { Config } from '../config.ts';
import { BudgetExceededError } from '../browser/budget.ts';
import { BrowserToolError } from '../browser/errors.ts';
import type { BrowserSession, SessionHandle } from '../browser/session.ts';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: ContentBlock[];
  isError?: boolean;
};

/**
 * O que cada módulo de ferramenta recebe. `run` é o que garante que toda
 * ferramenta abre a sessão do mesmo jeito e reprograma o fechamento por
 * ociosidade — nenhum módulo fala com o puppeteer diretamente.
 */
export interface ToolContext {
  config: Config;
  session: BrowserSession;
  run<T>(work: (handle: SessionHandle) => Promise<T>): Promise<T>;
}

export type ToolModule = (server: McpServer, ctx: ToolContext) => void;

export function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

/** JSON é o formato que o modelo lê melhor em listas e objetos. */
export function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

export function image(base64: string, mimeType: string, caption?: string): ToolResult {
  const content: ContentBlock[] = [{ type: 'image', data: base64, mimeType }];
  if (caption) content.push({ type: 'text', text: caption });
  return { content };
}

/**
 * Envelopa o handler para que nenhum erro vire stack trace crua.
 *
 * Um erro devolvido com `isError: true` é entendido pelo cliente MCP como "a
 * ferramenta falhou, mas o servidor está vivo" — o modelo lê a mensagem e pode
 * corrigir o caminho. Uma exceção não tratada derrubaria a chamada sem contexto.
 */
export async function guard(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return { ...text(err.message), isError: true };
    }
    if (err instanceof BrowserToolError) {
      return { ...text(err.message), isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    // Timeout do puppeteer é o erro mais comum e o mais fácil de agir sobre.
    if (/timeout/i.test(message)) {
      return {
        ...text(
          `A operação estourou o tempo limite: ${message}. A página pode estar ` +
            `lenta ou o seletor pode nunca aparecer. Tente take_snapshot para ver ` +
            `o estado atual.`
        ),
        isError: true,
      };
    }
    return { ...text(`Erro inesperado: ${message}`), isError: true };
  }
}

/**
 * O caminho padrão de toda ferramenta que age sobre uma aba: abre a sessão,
 * resolve a aba, drena o que a página acumulou desde a última chamada e só
 * então roda o trabalho.
 *
 * A drenagem vem ANTES da ação de propósito: uma navegação apaga o buffer da
 * página, então o que aconteceu antes dela precisa estar salvo primeiro.
 */
export function withPage(
  ctx: ToolContext,
  pageId: string | undefined,
  work: (args: { handle: SessionHandle; pageId: string; page: Page }) => Promise<ToolResult>
): Promise<ToolResult> {
  return guard(() =>
    ctx.run(async (handle) => {
      const { id, page } = await handle.page(pageId);
      await handle.drain(id, page);
      return work({ handle, pageId: id, page });
    })
  );
}

/** Nota de custo anexada quando a chamada precisou abrir um Chromium novo. */
export function launchNote(handle: SessionHandle, config: Config): string | null {
  if (!handle.launchedNow) return null;
  return (
    `(sessão de navegador nova aberta — ela fecha sozinha após ` +
    `${config.idleCloseSeconds}s sem uso, e o tempo aberto conta no orçamento diário)`
  );
}

/** Junta o resultado com a nota de custo, quando houver. */
export function withNote(result: ToolResult, note: string | null): ToolResult {
  if (!note) return result;
  return { ...result, content: [...result.content, { type: 'text', text: note }] };
}
