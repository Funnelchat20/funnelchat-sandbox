import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, defaultConfig, mergeConfig, parseArgs, resolveConfig } from '../src/config.js';
import { verify } from './vendor/funnelchat-node/src/webhooks/signature.js';
import { startReceiver, startSandbox } from './helpers.js';

describe('configuration', () => {
  it('defaults: port 4010, the portal retries, the rules on', () => {
    const config = defaultConfig();
    expect(config.port).toBe(4010);
    expect(config.webhooks).toMatchObject({ retryDelays: [60, 300, 1800], timeoutSeconds: 10, maxConsecutiveFailures: 5 });
    expect(config.rules).toEqual({ window: true, antiblock: true, rateLimit: true });
  });

  it('parses the flags', () => {
    const args = parseArgs(['--port', '5000', '--status-delays=0.5,1,-', '--retry-delays', '1,2', '--no-window', '--no-antiblock', '-q', '--require-https']);
    const config = mergeConfig(defaultConfig(), args.overrides);
    expect(config.port).toBe(5000);
    expect(config.statusDelays).toEqual({ sent: 0.5, delivered: 1, read: null });
    expect(config.webhooks.retryDelays).toEqual([1, 2]);
    expect(config.webhooks.requireHttps).toBe(true);
    expect(config.rules).toEqual({ window: false, antiblock: false, rateLimit: true });
    expect(config.log).toBe(false);
  });

  it('rejects unknown flags and bad values with a clear message', () => {
    expect(() => parseArgs(['--nope'])).toThrow(ConfigError);
    expect(() => parseArgs(['--retry-delays', 'a,b'])).toThrow(/no es un número de segundos/);
    expect(() => mergeConfig(defaultConfig(), { port: 70000 })).toThrow(ConfigError);
    expect(() => mergeConfig(defaultConfig(), { nope: 1 } as never)).toThrow(/Opción desconocida/);
  });

  it('reads a configuration file, and the flags win over it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-config-'));
    const file = join(dir, 'funnelchat-sandbox.config.json');
    writeFileSync(file, JSON.stringify({ port: 4500, rules: { rateLimit: false }, statusDelays: { read: null } }));
    const { config, configFile } = resolveConfig(parseArgs(['--port', '4600']), dir);
    expect(configFile).toBe(file);
    expect(config.port).toBe(4600);
    expect(config.rules.rateLimit).toBe(false);
    expect(config.statusDelays).toEqual({ sent: 1, delivered: 2, read: null });
  });

  it('a subscription of the configuration exists from the start, with its fixed secret', async () => {
    const receiver = await startReceiver();
    const secret = 'whsec_desarrolloLocal';
    const api = await startSandbox({ subscriptions: [{ url: receiver.url, events: ['message.received'], secret }] });
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    const [d] = await receiver.waitFor(1);
    expect(verify(d!.raw, String(d!.headers['x-funnelchat-signature']), secret)).toBe(true);
    // And again after a reset.
    await api.call('POST', '/_sandbox/reset');
    expect((await api.call('GET', '/api/v1/webhooks')).body).toHaveLength(1);
  });
});
