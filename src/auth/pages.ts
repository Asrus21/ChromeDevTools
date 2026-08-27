// As páginas HTML que um humano vê. São três: a home (o que é este servidor),
// a tela de consentimento (antes de mandar você para o GitHub) e a de erro.
//
// Tudo inline, sem CSS externo nem fonte remota: é uma página de OAuth, e
// qualquer request para terceiros aqui seria um passageiro a mais no fluxo de
// autenticação.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0f1115; color: #e6e8eb;
  }
  main { max-width: 560px; width: 100%; background: #171a21; border: 1px solid #262b36;
         border-radius: 14px; padding: 32px; }
  h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.01em; }
  p { margin: 12px 0; color: #b6bcc7; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  ul { color: #b6bcc7; padding-left: 20px; }
  li { margin: 6px 0; }
  .tag { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px;
         background: #1f2937; color: #93a4bd; margin-bottom: 16px; }
  .warn { background: #2a1f13; border: 1px solid #4a3418; border-radius: 10px;
          padding: 12px 16px; color: #e8c98a; font-size: 14px; }
  button { appearance: none; border: 0; border-radius: 10px; padding: 12px 20px;
           font: inherit; font-weight: 600; background: #4f8cff; color: #fff;
           cursor: pointer; width: 100%; margin-top: 20px; }
  button:hover { background: #3d7aeb; }
  .muted { color: #79818f; font-size: 13px; }
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function homePage(origin: string, serverName: string): string {
  return shell(
    serverName,
    `<span class="tag">MCP remoto · Cloudflare Workers</span>
     <h1>${escapeHtml(serverName)}</h1>
     <p>Este Worker expõe um Chrome headless — o Browser Rendering da Cloudflare —
        como ferramentas MCP: navegar, inspecionar a árvore de acessibilidade,
        clicar, preencher, ler console e rede, rodar script na página.</p>
     <p>Para conectar no Claude, adicione este endereço como conector:</p>
     <p><code>${escapeHtml(origin)}/mcp</code></p>
     <p class="muted">O acesso é restrito: só as contas do GitHub na lista de
        permitidos deste servidor conseguem autorizar. Cada sessão de navegador
        consome o orçamento de Browser Rendering da conta Cloudflare que hospeda
        isto aqui, então a lista não é decoração.</p>`
  );
}

export function approvalPage(options: {
  clientName: string;
  serverName: string;
  allowedHint: string;
  encodedState: string;
  budgetHint: string;
}): string {
  return shell(
    `Autorizar ${options.clientName}`,
    `<span class="tag">Pedido de conexão</span>
     <h1>Autorizar ${escapeHtml(options.clientName)}?</h1>
     <p><strong>${escapeHtml(options.clientName)}</strong> quer se conectar ao
        <strong>${escapeHtml(options.serverName)}</strong> e controlar um navegador
        remoto em seu nome.</p>
     <ul>
       <li>Abrir abas e navegar para qualquer endereço permitido</li>
       <li>Ler o conteúdo, o console e as requisições de rede das páginas</li>
       <li>Clicar, preencher formulários e executar JavaScript nelas</li>
     </ul>
     <div class="warn">${escapeHtml(options.budgetHint)}</div>
     <p class="muted">Ao continuar você vai para o login do GitHub. Só as contas
        <span class="mono">${escapeHtml(options.allowedHint)}</span> são aceitas.</p>
     <form method="post" action="/authorize">
       <input type="hidden" name="state" value="${escapeHtml(options.encodedState)}">
       <button type="submit">Continuar para o GitHub</button>
     </form>`
  );
}

export function errorPage(title: string, detail: string): string {
  return shell(
    title,
    `<span class="tag">Erro</span>
     <h1>${escapeHtml(title)}</h1>
     <p>${escapeHtml(detail)}</p>
     <p class="muted">Feche esta aba e tente conectar novamente pelo Claude.</p>`
  );
}
