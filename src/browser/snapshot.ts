// Snapshot de acessibilidade e o esquema de `uid`.
//
// O chrome-devtools-mcp oficial dá ao modelo uma árvore de acessibilidade em
// que cada nó tem um `uid`, e as ferramentas de interação (click, fill…)
// recebem esse uid em vez de um seletor CSS. É melhor que seletor porque o
// modelo enxerga papel e nome acessível — o mesmo que um leitor de tela — em
// vez de adivinhar `div.css-1x2y3z`.
//
// O problema aqui é que um uid precisa sobreviver entre DUAS chamadas de
// ferramenta, e entre elas a conexão com o navegador é fechada: um
// ElementHandle do puppeteer não atravessa isso.
//
// A solução é o uid ser posicional — `<seq>_<índice na travessia>` — e o
// snapshot ser refeito na hora do clique. Guardamos role+name de cada nó; se o
// nó do mesmo índice ainda tiver o mesmo papel e nome, é o mesmo elemento e
// clicamos nele. Se a página mudou, a divergência aparece e devolvemos um erro
// pedindo um snapshot novo, em vez de clicar no lugar errado.
//
// A alternativa seria carimbar `data-mcp-uid` no DOM, mas isso significa
// escrever na página inspecionada — o tipo de efeito colateral que estraga
// justamente a página que se está depurando.

/**
 * Forma mínima de um nó da árvore. Bate com o `SerializedAXNode` do puppeteer,
 * mas declarada aqui para as funções puras serem testáveis sem navegador.
 */
export interface AxLike {
  role: string;
  name?: string;
  value?: string | number;
  description?: string;
  checked?: boolean | 'mixed';
  pressed?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  selected?: boolean;
  required?: boolean;
  level?: number;
  children?: AxLike[];
}

export interface FlatNode<T extends AxLike = AxLike> {
  node: T;
  depth: number;
  index: number;
}

export interface FlattenResult<T extends AxLike = AxLike> {
  nodes: FlatNode<T>[];
  truncated: boolean;
}

/** Teto de nós por snapshot — uma página grande não pode estourar a resposta. */
export const DEFAULT_MAX_NODES = 1200;

/**
 * Achata a árvore em profundidade. A ORDEM É O CONTRATO: o índice de cada nó
 * aqui é o que vira uid, então esta função precisa ser determinística e
 * idêntica entre a chamada que gerou o snapshot e a que resolve o clique.
 */
export function flatten<T extends AxLike>(
  root: T | null,
  maxNodes: number = DEFAULT_MAX_NODES
): FlattenResult<T> {
  const nodes: FlatNode<T>[] = [];
  let truncated = false;
  if (!root) return { nodes, truncated };

  const visit = (node: T, depth: number): void => {
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    nodes.push({ node, depth, index: nodes.length });
    for (const child of (node.children ?? []) as T[]) visit(child, depth + 1);
  };
  visit(root, 0);
  return { nodes, truncated };
}

/** role+name de cada nó, que é o que guardamos para detectar página mudada. */
export function entriesOf(nodes: FlatNode[]): { role: string; name: string }[] {
  return nodes.map(({ node }) => ({ role: node.role, name: node.name ?? '' }));
}

/** true quando o nó daquele índice ainda é, para todo efeito, o mesmo nó. */
export function stillMatches(
  entry: { role: string; name: string } | undefined,
  node: AxLike | undefined
): boolean {
  if (!entry || !node) return false;
  return entry.role === node.role && entry.name === (node.name ?? '');
}

function attributes(node: AxLike): string[] {
  const out: string[] = [];
  if (node.value !== undefined && node.value !== '') out.push(`value=${JSON.stringify(String(node.value))}`);
  if (node.level !== undefined) out.push(`level=${node.level}`);
  if (node.checked !== undefined) out.push(`checked=${node.checked}`);
  if (node.pressed !== undefined) out.push(`pressed=${node.pressed}`);
  if (node.expanded !== undefined) out.push(`expanded=${node.expanded}`);
  if (node.selected) out.push('selected');
  if (node.required) out.push('required');
  if (node.disabled) out.push('disabled');
  if (node.focused) out.push('focused');
  return out;
}

/** Monta o uid que o modelo vai devolver nas ferramentas de interação. */
export function makeUid(seq: number, index: number): string {
  return `${seq}_${index}`;
}

export function parseUid(uid: string): { seq: number; index: number } | null {
  const match = /^(\d+)_(\d+)$/.exec(uid.trim());
  if (!match) return null;
  return { seq: Number(match[1]), index: Number(match[2]) };
}

/**
 * Renderiza a árvore no formato indentado que o modelo lê bem:
 *
 * ```
 * uid=3_0 RootWebArea "Example Domain"
 *   uid=3_1 heading "Example Domain" level=1
 *   uid=3_4 link "More information..."
 * ```
 */
export function renderSnapshot(
  seq: number,
  result: FlattenResult,
  header?: string
): string {
  const lines: string[] = [];
  if (header) lines.push(header);
  for (const { node, depth, index } of result.nodes) {
    const parts = [`${'  '.repeat(depth)}uid=${makeUid(seq, index)}`, node.role];
    if (node.name) parts.push(JSON.stringify(node.name));
    const extra = attributes(node);
    lines.push(extra.length ? `${parts.join(' ')} ${extra.join(' ')}` : parts.join(' '));
  }
  if (result.truncated) {
    lines.push(
      `… árvore truncada em ${result.nodes.length} nós. Use take_snapshot com ` +
        `um root mais específico, ou trabalhe com o que está visível aqui.`
    );
  }
  if (result.nodes.length === 0) {
    lines.push('(árvore de acessibilidade vazia — a página pode não ter carregado ainda)');
  }
  return lines.join('\n');
}
