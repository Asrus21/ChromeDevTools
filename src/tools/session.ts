// Controle explícito da sessão de navegador — as ferramentas de custo.
//
// Nenhuma das duas abre um Chromium: browser_status só lê contadores, e
// close_browser_session existe justamente para parar o relógio antes do
// timeout de ociosidade.

import { type ToolModule, guard, json, text } from './helpers.ts';

export const sessionTools: ToolModule = (server, ctx) => {
  server.registerTool(
    'browser_status',
    {
      title: 'Estado do navegador',
      description:
        'Mostra se há sessão de navegador aberta, quantas abas existem e quanto do ' +
        'orçamento diário já foi consumido — sem abrir navegador nenhum. Chame isto ' +
        'antes de uma sequência longa de automação, e quando quiser saber se ainda ' +
        'cabe trabalho hoje.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const status = await ctx.session.status();
        const { budget } = status;
        return json({
          sessao_aberta: status.sessionId !== null,
          abas: status.pages,
          limite_de_abas: ctx.config.maxPages,
          orcamento: {
            dia_utc: budget.day,
            usado_segundos: budget.usedSeconds,
            teto_segundos: budget.budgetSeconds,
            restante_segundos: budget.remainingSeconds,
            sessoes_abertas_na_conta: budget.openSessions,
          },
          limites_cloudflare: status.limits
            ? {
                sessoes_ativas: status.limits.active,
                maximo_concorrente: status.limits.max,
                novas_permitidas_agora: status.limits.allowedNow,
              }
            : 'não consultado',
          politica: {
            keep_alive_segundos: Math.round(ctx.config.keepAliveMs / 1000),
            fecha_apos_ocioso_segundos: ctx.config.idleCloseSeconds,
            dominios_permitidos: ctx.config.allowedDomains.length
              ? ctx.config.allowedDomains
              : 'sem restrição',
            resposta_a_dialogos: ctx.config.dialogDefault,
          },
          observacao:
            'O consumo é estimado pelo tempo entre abrir e fechar a sessão, que é ' +
            'o mesmo critério da cobrança. O número oficial está no painel da ' +
            'Cloudflare, em Compute > Browser Run.',
        });
      })
  );

  server.registerTool(
    'close_browser_session',
    {
      title: 'Fechar navegador',
      description:
        'Encerra a sessão de navegador agora, em vez de esperar o timeout de ' +
        'ociosidade. Isso para o relógio da cobrança e descarta abas, histórico de ' +
        'console e de rede. Use quando terminar uma tarefa — é a maneira mais direta ' +
        'de não gastar orçamento à toa.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const { closed, spentSeconds } = await ctx.session.close();
        if (!closed) return text('Não havia sessão de navegador aberta.');
        const budget = await ctx.session.budget.report();
        return json({
          fechada: true,
          duracao_da_sessao_segundos: spentSeconds,
          orcamento_restante_hoje_segundos: budget.remainingSeconds,
        });
      })
  );
};
