/**
 * The signature of the deliveries, checked three ways: against the portal's vectors (tests/test_firmas.py, the same
 * cases and the same fixed HMACs computed with Python), with the Node SDK's `verify` and with the portal snippet
 * `verificar-firma.js`, both copied unchanged into test/vendor (see test/vendor/procedencia.json).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { signature } from '../src/webhooks/signature.js';
import { BODY, FIXED_T, FIXED_VECTORS, SECRET, portalCases } from './fixtures/portal-signature-vectors.js';
import { startReceiver, startSandbox, subscribe } from './helpers.js';
import { checkSignature, verify } from './vendor/funnelchat-node/src/webhooks/signature.js';

const require = createRequire(import.meta.url);
const { verificarFirma } = require('./vendor/developers-portal/verificar-firma.cjs') as {
  verificarFirma: (body: Buffer | string, header: string, secret: string, tolerance?: number) => boolean;
};

const now = () => Math.floor(Date.now() / 1000);

describe('signature()', () => {
  it('produces the fixed vectors computed with Python hmac', () => {
    expect(signature(SECRET, BODY, FIXED_T)).toBe(`t=${FIXED_T},v1=${FIXED_VECTORS.body}`);
    expect(signature('9f3a1c7e5b2d4a6c8e0f1a3b5c7d9e1f', BODY, FIXED_T)).toBe(`t=${FIXED_T},v1=${FIXED_VECTORS.bodyWithSecretWithoutPrefix}`);
    const utf8 = Buffer.from('{"texto":"Ñandú 🚀 — acentos: áéíóú"}', 'utf8');
    expect(signature(SECRET, utf8, FIXED_T)).toBe(`t=${FIXED_T},v1=${FIXED_VECTORS.utf8Body}`);
  });

  it('signs a string and its UTF-8 bytes the same way', () => {
    expect(signature(SECRET, BODY.toString('utf8'), FIXED_T)).toBe(signature(SECRET, BODY, FIXED_T));
  });

  it('matches every valid case of the portal and is rejected where the portal rejects', () => {
    const t = now();
    for (const c of portalCases(t)) {
      // The SDK and the snippet agree with the expected result of test_firmas.py…
      expect(verify(c.body, c.header, c.secret), c.name).toBe(c.expected);
      expect(verificarFirma(c.body, c.header, c.secret), c.name).toBe(c.expected);
      // …and the sandbox signs the valid cases with exactly the header of the portal.
      if (c.expected) expect(signature(c.secret, c.body, Number(/t=(\d+)/.exec(c.header)?.[1])), c.name).toBe(c.header);
    }
  });
});

describe('a real delivery of the sandbox', () => {
  it('is verified by the Node SDK and by the portal snippet, over the raw body', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    const { secret } = await subscribe(api, receiver.url, ['message.received']);

    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000', device_id: 3, text: 'Hola, ¿precio? 🚀' });
    const [delivery] = await receiver.waitFor(1);
    const header = String(delivery?.headers['x-funnelchat-signature']);

    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verify(delivery!.raw, header, secret)).toBe(true);
    expect(checkSignature(delivery!.raw, header, secret)).toEqual({ ok: true });
    expect(verificarFirma(delivery!.raw, header, secret)).toBe(true);

    // Anything else fails, like it would in a real receiver.
    expect(verify(delivery!.raw, header, `${secret}x`)).toBe(false);
    expect(verify(Buffer.from(JSON.stringify(delivery!.json, null, 2)), header, secret)).toBe(false);
    expect(verificarFirma(delivery!.raw, header.replace(/t=\d+/, `t=${now() - 600}`), secret)).toBe(false);
  });

  it('carries the portal headers and the envelope, with the id and type of the body', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['message.received']);
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000', device_id: 3 });
    const [delivery] = await receiver.waitFor(1);

    expect(delivery!.headers['content-type']).toBe('application/json');
    expect(delivery!.headers['x-funnelchat-event']).toBe('message.received');
    expect(delivery!.headers['x-funnelchat-delivery']).toMatch(/^[0-9a-f-]{36}$/);
    expect(delivery!.headers['user-agent']).toBe('Funnelchat-Webhooks/1');
    expect(Object.keys(delivery!.json)).toEqual(['id', 'type', 'version', 'occurred_at', 'data']);
    expect(delivery!.json.id).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(delivery!.json.type).toBe('message.received');
    expect(delivery!.json.version).toBe(1);
    expect(delivery!.json.occurred_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('signs each subscription with its own secret', async () => {
    const api = await startSandbox();
    const a = await startReceiver();
    const b = await startReceiver();
    const subA = await subscribe(api, a.url, ['contact.created']);
    const subB = await subscribe(api, b.url, ['contact.created']);
    await api.call('POST', '/api/v1/contacts', { phone: '5491100000077', name: 'Ana' });
    const [da] = await a.waitFor(1);
    const [db] = await b.waitFor(1);

    expect(da!.json.id).toBe(db!.json.id);
    expect(verify(da!.raw, String(da!.headers['x-funnelchat-signature']), subA.secret)).toBe(true);
    expect(verify(db!.raw, String(db!.headers['x-funnelchat-signature']), subB.secret)).toBe(true);
    expect(verify(da!.raw, String(da!.headers['x-funnelchat-signature']), subB.secret)).toBe(false);
  });
});

// The SDK's own checkout, when it is next to this repo: the same check against its current code, not the copy.
const sdkSignature = resolve(process.env.FUNNELCHAT_NODE_SDK ?? resolve(import.meta.dirname, '../../funnelchat-node'), 'src/webhooks/signature.ts');

describe.skipIf(!existsSync(sdkSignature))('the Node SDK checkout next to this repo', () => {
  it('verifies a delivery of the sandbox', async () => {
    const sdk = (await import(pathToFileURL(sdkSignature).href)) as { verify: typeof verify };
    const api = await startSandbox();
    const receiver = await startReceiver();
    const { secret } = await subscribe(api, receiver.url, ['message.received']);
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    const [delivery] = await receiver.waitFor(1);
    expect(sdk.verify(delivery!.raw, String(delivery!.headers['x-funnelchat-signature']), secret)).toBe(true);
  });
});
