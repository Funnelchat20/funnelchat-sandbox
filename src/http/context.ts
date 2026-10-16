import type { SandboxApp } from '../app.js';
import type { IndexedOperation } from '../openapi/spec.js';

export interface HandlerContext {
  app: SandboxApp;
  op: IndexedOperation;
  /** Path parameters, coerced to their schema types. */
  path: Record<string, unknown>;
  /** Query, parsed the way Laravel reads it and coerced where the spec declares the parameter. */
  query: Record<string, unknown>;
  /** JSON body, coerced to the schema (`undefined` when there is none). */
  body: unknown;
  /** Request headers, lower case. */
  headers: Record<string, string | undefined>;
  /** `http://host:port` as the client called it. */
  origin: string;
  /** The requested path, without the query. */
  pathname: string;
}

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: HandlerContext) => HandlerResult | Promise<HandlerResult>;

/** Handlers keyed by `METHOD /path/{template}`, exactly as in the spec. */
export type HandlerTable = Record<string, Handler>;

export const ok = (body: unknown, status = 200): HandlerResult => ({ status, body });
export const noContent = (): HandlerResult => ({ status: 204 });

export function listContext(ctx: HandlerContext): { path: string; query: Record<string, unknown> } {
  return { path: `${ctx.origin}${ctx.pathname}`, query: ctx.query };
}

export function body(ctx: HandlerContext): Record<string, unknown> {
  return typeof ctx.body === 'object' && ctx.body !== null && !Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>) : {};
}
