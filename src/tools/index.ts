// Registro central das ferramentas expostas pelo servidor MCP.
//
// O recorte é proposital. O chrome-devtools-mcp oficial tem mais de 50
// ferramentas porque roda num Chrome local, com sistema de arquivos e sem
// conta de custo. Aqui o Chromium é gerenciado pela Cloudflare, cobrado por
// tempo aberto e sem disco — o README explica ferramenta por ferramenta o que
// ficou de fora e por quê.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { debugTools } from './debug.ts';
import type { ToolContext } from './helpers.ts';
import { inspectTools } from './inspect.ts';
import { interactTools } from './interact.ts';
import { navigationTools } from './navigation.ts';
import { sessionTools } from './session.ts';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  navigationTools(server, ctx);
  inspectTools(server, ctx);
  interactTools(server, ctx);
  debugTools(server, ctx);
  sessionTools(server, ctx);
}
