// Junção das duas fontes de rede que o coletor produz.
//
// Dentro da página há dois observadores, e cada um sabe metade da história:
//
//   PerformanceObserver  vê TODA requisição (imagem, css, script, xhr, fetch),
//                        com status, duração e bytes — mas não o método HTTP.
//   patches de fetch/XHR veem o método e o status das chamadas de aplicação —
//                        mas não enxergam recurso carregado pelo próprio HTML.
//
// A mesma requisição aparece nas duas listas. Esta função funde os pares e
// deixa uma linha só, com o melhor de cada lado.

import type { NetworkEntry } from '../types.ts';

/** Janela em que duas observações da mesma URL são consideradas a mesma requisição. */
const MERGE_WINDOW_MS = 3000;

export function mergeNetworkEntries(entries: NetworkEntry[]): NetworkEntry[] {
  const perf: NetworkEntry[] = [];
  const app: NetworkEntry[] = [];
  for (const entry of entries) {
    (entry.via === 'fetch' || entry.via === 'xhr' ? app : perf).push(entry);
  }

  const consumed = new Set<number>();
  const merged: NetworkEntry[] = app.map((entry) => {
    const matchIndex = perf.findIndex(
      (candidate, index) =>
        !consumed.has(index) &&
        candidate.url === entry.url &&
        Math.abs(candidate.at - entry.at) <= MERGE_WINDOW_MS
    );
    if (matchIndex < 0) return entry;

    consumed.add(matchIndex);
    const match = perf[matchIndex]!;
    return {
      ...entry,
      // O status do patch é o que a aplicação viu; o do PerformanceObserver
      // cobre o caso em que a promise foi rejeitada antes de virar resposta.
      status: entry.status ?? match.status ?? null,
      bytes: entry.bytes ?? match.bytes ?? null,
      ms: entry.ms ?? match.ms ?? null,
      type: entry.type ?? match.type ?? null,
    };
  });

  for (const [index, entry] of perf.entries()) {
    if (!consumed.has(index)) merged.push(entry);
  }

  return merged.sort((a, b) => a.at - b.at);
}

/** Filtro comum das ferramentas de listagem. */
export function filterNetworkEntries(
  entries: NetworkEntry[],
  options: { urlContains?: string; onlyFailures?: boolean; types?: string[] }
): NetworkEntry[] {
  const needle = options.urlContains?.toLowerCase();
  const types = options.types?.length ? new Set(options.types) : null;

  return entries.filter((entry) => {
    if (needle && !entry.url.toLowerCase().includes(needle)) return false;
    if (types && !types.has(entry.type ?? '')) return false;
    if (options.onlyFailures) {
      // Sem status é uma requisição que nem chegou a responder — também é falha.
      if (entry.status !== null && entry.status !== undefined && entry.status < 400) return false;
    }
    return true;
  });
}
