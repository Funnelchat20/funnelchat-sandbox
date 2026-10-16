/**
 * Parses a query string the way PHP / Laravel reads it: `a[]=1&a[]=2` → {a: ["1", "2"]},
 * `f[0][mode]=all` → {f: {"0": {mode: "all"}}}, `x[y]=1` → {x: {y: "1"}}. A repeated plain key keeps the last value.
 */
export function parseQuery(search: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of search) {
    const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(rawKey);
    if (!match) {
      out[rawKey] = value;
      continue;
    }
    const base = match[1] as string;
    const path = [...(match[2] ?? '').matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1] as string);
    if (path.length === 0) {
      out[base] = value;
      continue;
    }
    let holder: Record<string, unknown> | unknown[] = out;
    let key: string = base;
    for (const segment of path) {
      const container = holder as Record<string, unknown>;
      if (segment === '') {
        // `key[]`: append to a list.
        const list = Array.isArray(container[key]) ? (container[key] as unknown[]) : (container[key] = []);
        (list as unknown[]).push(undefined);
        holder = list as unknown[];
        key = String((list as unknown[]).length - 1);
      } else {
        // `key[name]`: a nested object.
        const next = container[key];
        holder = typeof next === 'object' && next !== null ? (next as Record<string, unknown>) : (container[key] = {});
        key = segment;
      }
    }
    (holder as Record<string, unknown>)[key] = value;
  }
  return out;
}
