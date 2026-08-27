// Erros de uso das ferramentas, num módulo sem dependência nenhuma.
//
// Mora separado de session.ts de propósito: assim as ferramentas e os testes
// conseguem importá-lo sem arrastar o @cloudflare/puppeteer junto, que só
// carrega dentro do runtime dos Workers.

/**
 * Erro que o modelo consegue agir sobre: aba que não existe, uid velho,
 * navegação bloqueada. Vira `isError: true` com a mensagem inteira, em vez de
 * stack trace.
 */
export class BrowserToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserToolError';
  }
}
