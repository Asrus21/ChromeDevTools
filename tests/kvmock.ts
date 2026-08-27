// KV de mentira, em memória. Só o que o BudgetLedger usa: get (texto e json),
// put, delete e list com prefixo. Existe para o orçamento ser testável sem
// tocar em conta nenhuma da Cloudflare.

export class FakeKV {
  readonly store = new Map<string, string>();
  /** Contador de escritas, para o teste conferir que não escrevemos à toa. */
  writes = 0;

  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return type === 'json' ? JSON.parse(raw) : raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cacheStatus: null;
  }> {
    const prefix = options?.prefix ?? '';
    return {
      keys: [...this.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    };
  }
}

/** O cast que o TypeScript exige — o mock só implementa o subconjunto usado. */
export function asKV(fake: FakeKV): KVNamespace {
  return fake as unknown as KVNamespace;
}
