/**
 * Laravel's two paginators, with the same `data` / `links` / `meta` keys the SDKs read.
 */
import { ApiError } from './errors.js';

export interface ListContext {
  /** `http://host:port/api/v1/...` without the query: Laravel's `path`. */
  path: string;
  query: Record<string, unknown>;
  /**
   * The query as the client sent it. The links copy it as is, like Laravel's `withQueryString()` and the key listings'
   * `KeyListingPage::baseQuery()`: `activeConversation=1` stays `1` (the coerced `true` would be a 422 on the next
   * page) and a list such as `status[]=0` stays in the link.
   */
  raw?: URLSearchParams;
}

function perPageOf(query: Record<string, unknown>, fallback: number, max = 100): number {
  const raw = query.perPage ?? query.per_page ?? query.pageSize;
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * The query of a link: the one the client sent (`ctx.raw`) without the keys in `drop`, with `extra` at the end. Without
 * the raw query (a handler that builds its own context), the scalar values of `ctx.query`, a boolean as `1` or `0`: the
 * only values Laravel's `boolean` rule accepts in a query.
 */
export function linkQuery(ctx: ListContext, extra: Record<string, string | number>, drop: string[] = []): URLSearchParams {
  let params: URLSearchParams;
  if (ctx.raw) params = new URLSearchParams(ctx.raw);
  else {
    params = new URLSearchParams();
    for (const [key, value] of Object.entries(ctx.query)) {
      if (value === undefined || value === null || typeof value === 'object') continue;
      params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
  }
  for (const key of [...drop, ...Object.keys(extra)]) params.delete(key);
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params;
}

function urlWith(ctx: ListContext, extra: Record<string, string | number>, drop: string[] = []): string {
  const qs = linkQuery(ctx, extra, drop).toString();
  return qs ? `${ctx.path}?${qs}` : ctx.path;
}

/** `LengthAwarePaginator`: `?page=N`, `meta.current_page` / `meta.last_page`, `meta.links`. */
export function paginate<T>(items: T[], ctx: ListContext, map: (item: T) => unknown, fallbackPerPage = 25): Record<string, unknown> {
  const perPage = perPageOf(ctx.query, fallbackPerPage);
  const pageRaw = Number(ctx.query.page ?? 1);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const from = slice.length ? (page - 1) * perPage + 1 : null;
  const to = slice.length ? (from as number) + slice.length - 1 : null;
  const link = (n: number) => urlWith(ctx, { page: n });
  const pageLinks = [
    { url: page > 1 ? link(page - 1) : null, label: '&laquo; Anterior', active: false },
    ...Array.from({ length: lastPage }, (_, i) => ({ url: link(i + 1), label: String(i + 1), active: i + 1 === page })),
    { url: page < lastPage ? link(page + 1) : null, label: 'Siguiente &raquo;', active: false },
  ];
  return {
    data: slice.map(map),
    links: {
      first: link(1),
      last: link(lastPage),
      prev: page > 1 ? link(page - 1) : null,
      next: page < lastPage ? link(page + 1) : null,
    },
    meta: { current_page: page, from, last_page: lastPage, links: pageLinks, path: ctx.path, per_page: perPage, to, total },
  };
}

function encodeCursor(position: number): string {
  return Buffer.from(JSON.stringify({ position, _pointsToNextItems: true }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')) as { position?: unknown };
    if (typeof parsed.position === 'number' && Number.isInteger(parsed.position) && parsed.position >= 0) return parsed.position;
  } catch {
    // fall through
  }
  throw new ApiError(422, 'validation_failed', 'El cursor no es válido.', { errors: { cursor: ['El cursor no es válido.'] } });
}

/** `CursorPaginator`: `?cursor=…`, `meta.next_cursor` / `meta.prev_cursor`, no totals. */
export function cursorPaginate<T>(items: T[], ctx: ListContext, map: (item: T) => unknown, fallbackPerPage = 25): Record<string, unknown> {
  const perPage = perPageOf(ctx.query, fallbackPerPage);
  const start = decodeCursor(ctx.query.cursor);
  const slice = items.slice(start, start + perPage);
  const next = start + perPage < items.length ? encodeCursor(start + perPage) : null;
  const prev = start > 0 ? encodeCursor(Math.max(0, start - perPage)) : null;
  return {
    data: slice.map(map),
    links: {
      first: null,
      last: null,
      prev: prev ? urlWith(ctx, { cursor: prev }) : null,
      next: next ? urlWith(ctx, { cursor: next }) : null,
    },
    meta: { path: ctx.path, per_page: perPage, next_cursor: next, prev_cursor: prev },
  };
}
