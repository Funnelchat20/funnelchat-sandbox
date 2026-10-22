/**
 * The HTTP server: the public API under `/api/v1/...` (validated against the spec, with an API key) and the
 * sandbox's own routes under `/_sandbox/...` (no key).
 *
 * For an API request: route of the spec (or `404 route_not_found`) → API key (`401 unauthenticated`) → validation of
 * path, query and body (`404` / `422 validation_failed`) → the stateful handler, or the example of the response
 * schema for the routes without state.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SandboxApp, type Logger } from './app.js';
import { defaultConfig, mergeConfig, type ConfigInput, type SandboxConfig } from './config.js';
import { contactHandlers } from './handlers/contacts.js';
import { formHandlers } from './handlers/forms.js';
import { GATE_CLOSED, groupHandlers } from './handlers/groups.js';
import { messageHandlers } from './handlers/messages.js';
import { webhookHandlers } from './handlers/webhooks.js';
import type { HandlerResult, HandlerTable } from './http/context.js';
import { takeEdgeFailure } from './http/edge.js';
import { ApiError, edgeError, methodNotAllowed, notFound, routeNotAvailable, routeNotFound, unauthenticated, validationFailed } from './http/errors.js';
import { parseQuery } from './http/query.js';
import { exampleFor } from './openapi/example.js';
import { matchRoute, requestBodySchema, spec, successResponse } from './openapi/spec.js';
import { validateRequest } from './openapi/validate.js';
import { handleSandbox } from './sandbox/routes.js';
import { truncate } from './util.js';
import { VERSION } from './version.js';

const MAX_BODY_BYTES = 1024 * 1024;

/** `Authorization: Bearer <id>|fc_live_...`: any well-formed key is accepted. */
const API_KEY = /^Bearer\s+(\d+)\|fc_live_[A-Za-z0-9]+$/;

const handlers: HandlerTable = { ...contactHandlers, ...messageHandlers, ...formHandlers, ...groupHandlers, ...webhookHandlers };

class BodyError extends ApiError {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyError(413, 'payload_too_large', 'El cuerpo supera 1 MB.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  const text = raw.toString('utf8');
  if (contentType?.includes('application/x-www-form-urlencoded')) return parseQuery(new URLSearchParams(text));
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400, 'invalid_json', 'El cuerpo no es JSON válido.');
  }
}

function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return out;
}

/**
 * `X-Request-Id`: a fresh UUID v4 on every answer, errors included, like api-edge v0.3.0 and platform-gate 0.8. Only
 * in the header, never in the body; one the client sends is ignored.
 */
export const REQUEST_ID_HEADER = 'X-Request-Id';

function send(res: ServerResponse, requestId: string, result: { status: number; body?: unknown; headers?: Record<string, string> }): void {
  const headers: Record<string, string> = { 'X-Funnelchat-Sandbox': VERSION, ...result.headers, [REQUEST_ID_HEADER]: requestId };
  if (result.status === 204 || result.body === undefined) {
    res.writeHead(result.status, headers);
    res.end();
    return;
  }
  res.writeHead(result.status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(result.body));
}

function errorResult(error: unknown): HandlerResult {
  if (error instanceof ApiError) return { status: error.status, body: error.body(), headers: error.headers };
  console.error('[sandbox] unexpected error:', error);
  return { status: 500, body: { error: 'server_error', message: 'The sandbox had an unexpected error. See its console.' } };
}

/** A webhook secret is shown once, to whoever asked for it: the request log of the panel keeps it hidden. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'secret' && typeof v === 'string' ? 'whsec_… (oculto)' : redact(v)]));
}

const loggable = (body: unknown): unknown => {
  if (body === undefined) return null;
  const safe = redact(body);
  const text = JSON.stringify(safe);
  return text.length > 4000 ? truncate(text, 4000) : safe;
};

export interface Sandbox {
  app: SandboxApp;
  server: Server;
  /** Starts listening; resolves with the URL. Port `0` takes a free one. */
  listen(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

export interface CreateSandboxOptions {
  config?: ConfigInput | SandboxConfig;
  logger?: Logger;
}

export function createSandbox(options: CreateSandboxOptions = {}): Sandbox {
  const config = mergeConfig(defaultConfig(), (options.config ?? {}) as ConfigInput);
  const app = new SandboxApp(config, options.logger);

  async function handleApi(req: IncomingMessage, url: URL, headers: Record<string, string | undefined>): Promise<{ result: HandlerResult; operation: string | null; requestBody: unknown }> {
    const method = (req.method ?? 'GET').toUpperCase();
    const { match, allowed } = matchRoute(method, url.pathname);
    let requestBody: unknown;
    // A forced error of the edge: it answers before the domain, or (`applied`) after the domain did the work.
    let edge: ReturnType<typeof takeEdgeFailure>;
    try {
      edge = takeEdgeFailure(app, headers);
    } catch (error) {
      return { result: errorResult(error), operation: match?.op.key ?? null, requestBody };
    }
    if (edge && !edge.applied) return { result: errorResult(edgeError(edge.code)), operation: match?.op.key ?? null, requestBody };
    const answer = await handleRoute(req, url, headers, method, match, allowed);
    if (edge) return { ...answer, result: errorResult(edgeError(edge.code)) };
    return answer;
  }

  async function handleRoute(
    req: IncomingMessage,
    url: URL,
    headers: Record<string, string | undefined>,
    method: string,
    match: ReturnType<typeof matchRoute>['match'],
    allowed: string[],
  ): Promise<{ result: HandlerResult; operation: string | null; requestBody: unknown }> {
    let requestBody: unknown;
    if (!match) {
      return { result: errorResult(allowed.length ? methodNotAllowed(method, allowed) : routeNotFound()), operation: null, requestBody };
    }
    const { op } = match;
    try {
      if (!API_KEY.test(headers.authorization?.trim() ?? '')) throw unauthenticated();
      // A route no key enables: the gate answers before the domain validates anything.
      if (GATE_CLOSED.has(`${op.method.toUpperCase()} ${op.path}`)) throw routeNotAvailable();
      requestBody = parseBody(await readBody(req), headers['content-type']);
      const validation = validateRequest(op.operation, match.params, parseQuery(url.searchParams), requestBody, requestBodySchema(op.operation));
      if (!validation.ok) {
        if (validation.kind === 'not_found') throw notFound();
        throw validationFailed(validation.errors);
      }
      const handler = handlers[`${op.method.toUpperCase()} ${op.path}`];
      const ctx = {
        app,
        op,
        path: validation.value.path,
        query: validation.value.query,
        body: validation.value.body,
        headers,
        origin: `http://${headers.host ?? `localhost:${config.port}`}`,
        pathname: url.pathname,
      };
      if (handler) return { result: await handler(ctx), operation: op.key, requestBody };
      // No state for this route: the example of its response schema.
      const success = successResponse(op.operation);
      const example = success.example ?? (success.schema ? exampleFor(success.schema) : undefined);
      return { result: { status: success.status, body: success.status === 204 ? undefined : example }, operation: op.key, requestBody };
    } catch (error) {
      return { result: errorResult(error), operation: op.key, requestBody };
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = randomUUID();
    const url = new URL(req.url ?? '/', 'http://sandbox.local');
    const headers = lowerHeaders(req);
    const method = (req.method ?? 'GET').toUpperCase();

    if (url.pathname === '/_sandbox' || url.pathname.startsWith('/_sandbox/')) {
      try {
        if (method === 'GET' && url.pathname === '/_sandbox/openapi.json') {
          send(res, requestId, { status: 200, body: spec });
          return;
        }
        const body = method === 'GET' ? undefined : parseBody(await readBody(req), headers['content-type']);
        const answer = await handleSandbox(app, { method, path: url.pathname.replace(/\/+$/, '') || '/_sandbox', query: url.searchParams, body });
        if (!answer) {
          send(res, requestId, errorResult(new ApiError(404, 'route_not_found', 'That sandbox route does not exist. The panel is at /_sandbox.')));
        } else if (answer.html !== undefined) {
          res.writeHead(answer.status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Funnelchat-Sandbox': VERSION, [REQUEST_ID_HEADER]: requestId });
          res.end(answer.html);
        } else {
          send(res, requestId, answer);
        }
      } catch (error) {
        send(res, requestId, errorResult(error));
      }
      return;
    }

    if (url.pathname === '/' && method === 'GET') {
      send(res, requestId, {
        status: 200,
        body: { name: 'funnelchat-sandbox', version: VERSION, api: '/api/v1', panel: '/_sandbox', spec: '/_sandbox/openapi.json' },
      });
      return;
    }

    const { result, operation, requestBody } = await handleApi(req, url, headers);
    send(res, requestId, result);
    const durationMs = Date.now() - started;
    app.store.logRequest({
      at: new Date(started),
      requestId,
      method,
      path: `${url.pathname}${url.search}`,
      status: result.status,
      durationMs,
      operation,
      requestBody: loggable(requestBody),
      responseBody: loggable(result.body),
    });
    app.logger.info(`${method} ${url.pathname}${url.search} → ${result.status} (${durationMs} ms)`);
  }

  const server = createServer((req, res) => {
    onRequest(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, randomUUID(), errorResult(error));
      else res.end();
    });
  });

  return {
    app,
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          const { port } = server.address() as AddressInfo;
          const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
          resolve({ url: `http://${host}:${port}`, port });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        app.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
