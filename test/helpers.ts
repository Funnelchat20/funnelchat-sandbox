import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach } from 'vitest';
import { createSandbox, type ConfigInput, type Sandbox } from '../src/index.js';
import { silentLogger } from '../src/app.js';

export const API_KEY = '1|fc_live_sandboxTest0000000000000000000000000000';

const open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

export interface Api {
  url: string;
  sandbox: Sandbox;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
}

/** A sandbox on a free port, quiet, with short delays. Closed after each test. */
export async function startSandbox(config: ConfigInput = {}): Promise<Api> {
  const sandbox = createSandbox({
    config: {
      port: 0,
      log: false,
      ...config,
      statusDelays: { sent: 0.02, delivered: 0.02, read: 0.02, ...config.statusDelays },
      webhooks: { retryDelays: [0.02, 0.02, 0.02], timeoutSeconds: 2, ...config.webhooks },
    },
    logger: silentLogger,
  });
  const { url } = await sandbox.listen();
  open.push(sandbox);
  return {
    url,
    sandbox,
    async call(method, path, body, headers = {}) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed, headers: response.headers };
    },
  };
}

export interface Received {
  raw: Buffer;
  headers: IncomingMessage['headers'];
  json: any;
}

export interface Receiver {
  url: string;
  received: Received[];
  /** The status to answer, in order; the last one repeats. */
  answers: number[];
  waitFor(count: number, timeoutMs?: number): Promise<Received[]>;
}

/** A local HTTP server that records every delivery, with its raw body, and answers `answers`. */
export async function startReceiver(answers: number[] = [200]): Promise<Receiver> {
  const received: Received[] = [];
  const receiver = { answers } as Receiver;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      received.push({ raw, headers: req.headers, json: JSON.parse(raw.toString('utf8')) });
      const status = receiver.answers[Math.min(received.length - 1, receiver.answers.length - 1)] ?? 200;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(status < 300 ? 'ok' : 'failed');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  receiver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
  receiver.received = received;
  receiver.waitFor = async (count, timeoutMs = 3000) => {
    const until = Date.now() + timeoutMs;
    while (received.length < count) {
      if (Date.now() > until) throw new Error(`${received.length} deliveries arrived; ${count} were expected.`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return received;
  };
  return receiver;
}

/** Waits until `check` is true. */
export async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > limit) throw new Error('Timed out waiting.');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Creates a subscription and returns it with its secret. */
export async function subscribe(api: Api, url: string, events: string[]): Promise<{ id: string; secret: string }> {
  const res = await api.call('POST', '/api/v1/webhooks', { url, events, description: 'test' });
  if (res.status !== 201) throw new Error(`The subscription was not created: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
