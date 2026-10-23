/**
 * The sign-up of numbers by API (contract of 22-10, A1 and A3, and its amendment v0.1 of 23-10): a number by QR and
 * its code, the quota, `same_number_as`, `Idempotency-Key`, the sign-up links with their hosted page, and the four
 * signed `device.*` events with `connect_link_id`.
 */
import { describe, expect, it } from 'vitest';
import { signature } from '../src/webhooks/signature.js';
import { API_KEY, startReceiver, startSandbox, subscribe, type Api } from './helpers.js';

const DEVICE_EVENTS = ['device.connected', 'device.disconnected', 'device.deleted', 'device.health_changed'];

interface PageResult {
  status: number;
  location: string | null;
  headers: Headers;
  text: string;
}

/** A request to the hosted page like a browser makes it, without following the redirect. */
async function visit(url: string, init: RequestInit = {}): Promise<PageResult> {
  const response = await fetch(url, { redirect: 'manual', ...init });
  return { status: response.status, location: response.headers.get('location'), headers: response.headers, text: await response.text() };
}

/** The button of the page: claims the link (the sandbox connects at once). */
const start = (url: string, body: Record<string, string> = {}) =>
  visit(`${url}/start`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

async function createLink(api: Api, body: Record<string, unknown>) {
  const res = await api.call('POST', '/api/v1/connect-links', body);
  if (res.status !== 201) throw new Error(`The link was not created: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

describe('a number by QR', () => {
  it('creates it unconnected, gives a fake QR, connects with the scan, filters by reference and deletes it', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    const sub = await subscribe(api, receiver.url, DEVICE_EVENTS);

    const created = await api.call('POST', '/api/v1/devices', { connection: 'qr', alias: 'Tienda Ana', external_reference: 'cliente-8841' });
    expect(created.status).toBe(201);
    const device = created.body.data;
    expect(device).toMatchObject({ id: 5, alias: 'Tienda Ana', connected: 0, provider: 1, number: '', normalized_number: null, connection: 'qr', external_reference: 'cliente-8841' });

    const qr = await api.call('GET', `/api/v1/devices/${device.id}/qr`);
    expect(qr.body.data).toMatchObject({ connected: false, expires_in: 20 });
    const png = Buffer.from(qr.body.data.qr_code.replace(/^data:image\/png;base64,/, ''), 'base64');
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect((await api.call('GET', '/api/v1/devices/3/qr')).body).toMatchObject({ error: 'provider_unsupported' });

    // The scan.
    const scan = await api.call('POST', `/_sandbox/devices/${device.id}/connect`, { number: '+54 9 11 5555-0101' });
    expect(scan.body.event.type).toBe('device.connected');
    expect((await api.call('GET', `/api/v1/devices/${device.id}/qr`)).body.data).toEqual({ connected: true, qr_code: null, expires_in: 0 });

    const [delivery] = await receiver.waitFor(1);
    const t = /t=(\d+)/.exec(String(delivery!.headers['x-funnelchat-signature']))![1];
    expect(delivery!.headers['x-funnelchat-signature']).toBe(signature(sub.secret, delivery!.raw, Number(t)));
    expect(delivery!.json.data).toEqual({
      device: { id: device.id, name: 'Tienda Ana', number: '5491155550101', connection: 'qr', external_reference: 'cliente-8841' },
      connected_at: expect.any(String),
      connect_link_id: null,
    });

    const filtered = await api.call('GET', '/api/v1/devices?external_reference=cliente-8841');
    expect(filtered.body.data.map((d: { id: number }) => d.id)).toEqual([device.id]);
    expect((await api.call('GET', '/api/v1/devices?external_reference=cliente-88')).body.data).toEqual([]);

    const renamed = await api.call('PUT', `/api/v1/devices/${device.id}`, { external_reference: 'cliente-9000' });
    expect(renamed.body).toMatchObject({ external_reference: 'cliente-9000' });

    const deleted = await api.call('DELETE', `/api/v1/devices/${device.id}`);
    expect(deleted).toMatchObject({ status: 200, body: null });
    const deliveries = await receiver.waitFor(2);
    expect(deliveries[1]!.json).toMatchObject({ type: 'device.deleted', data: { device: { id: device.id, external_reference: 'cliente-9000', connection: 'qr' }, connect_link_id: null } });
    expect((await api.call('GET', `/api/v1/devices/${device.id}`)).status).toBe(404);
    expect((await api.call('GET', '/_sandbox/numbers')).body).toMatchObject({ in_use: 2 });
  });

  it('applies the quota (a phone counts once), keeps one unconnected QR number, and answers invalid_request', async () => {
    const api = await startSandbox({ numbers: { limit: 4 } });
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr' })).status).toBe(201);
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr' })).body).toMatchObject({ error: 'pending_number_exists', device_id: 5 });
    await api.call('POST', '/_sandbox/devices/5/connect');
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr' })).status).toBe(201);
    const full = await api.call('POST', '/api/v1/devices', { connection: 'qr' });
    expect(full).toMatchObject({ status: 403, body: { error: 'number_limit_reached', limit: 4, used: 4, pending_device_ids: [6] } });
    await api.call('POST', '/_sandbox/numbers', { included: false });
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr' })).body.error).toBe('numbers_not_included');
    const invalid = await api.call('POST', '/api/v1/devices', { connection: 'meta' });
    expect(invalid).toMatchObject({ status: 422, body: { error: 'invalid_request', errors: { connection: expect.any(Array) } } });
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr', same_number_as: 99 })).body.error).toBe('invalid_reference_device');
  });

  it('same_number_as: only on a number in coexistence without QR, and it takes no place', async () => {
    const api = await startSandbox({ numbers: { limit: 3 } });
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr', same_number_as: 3 })).body.error).toBe('qr_requires_coexistence');
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr', same_number_as: 4 })).body).toMatchObject({ error: 'method_already_present', device_id: 4 });

    const link = await createLink(api, { type: 'meta', allowed_connection_types: ['coexistence'] });
    await start(link.url);
    const coexistence = (await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data.device_id;
    expect((await api.call('GET', `/api/v1/devices/${coexistence}`)).body).toMatchObject({ connection: 'coexistence', is_coexistence: true });

    // The account is full (3 places), yet QR on the same phone is accepted.
    const qr = await api.call('POST', '/api/v1/devices', { connection: 'qr', same_number_as: coexistence });
    expect(qr.status).toBe(201);
    expect(qr.body.data.number).toBe((await api.call('GET', `/api/v1/devices/${coexistence}`)).body.number);
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr', same_number_as: coexistence })).body).toMatchObject({ error: 'method_already_present', device_id: qr.body.data.id });
    expect((await api.call('GET', '/_sandbox/numbers')).body).toMatchObject({ in_use: 3 });
  });
});

describe('Idempotency-Key', () => {
  it('replays a 2xx with Idempotent-Replayed, per resource; another body answers 422; a rejection is evaluated again', async () => {
    const api = await startSandbox({ numbers: { limit: 2 } });
    const headers = { 'Idempotency-Key': 'alta-8841' };
    const rejected = await api.call('POST', '/api/v1/devices', { connection: 'qr' }, headers);
    expect(rejected.body.error).toBe('number_limit_reached');
    await api.call('POST', '/_sandbox/numbers', { limit: 10 });

    const first = await api.call('POST', '/api/v1/devices', { connection: 'qr', alias: 'A' }, headers);
    const again = await api.call('POST', '/api/v1/devices', { alias: 'A', connection: 'qr' }, headers);
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.data.id).toBe(first.body.data.id);
    expect((await api.call('GET', '/api/v1/devices')).body.meta.total).toBe(3);

    const other = await api.call('POST', '/api/v1/devices', { connection: 'qr', alias: 'B' }, headers);
    expect(other).toMatchObject({ status: 422, body: { error: 'idempotency_key_mismatch' } });
    // The same key on the other resource is another slot.
    const link = await api.call('POST', '/api/v1/connect-links', { type: 'qr' }, headers);
    const linkAgain = await api.call('POST', '/api/v1/connect-links', { type: 'qr' }, headers);
    expect(link.status).toBe(201);
    expect(linkAgain.body.data).toEqual(link.body.data);
    expect(linkAgain.headers.get('idempotent-replayed')).toBe('true');

    for (const key of ['x'.repeat(256), 'con espacio']) {
      expect((await api.call('POST', '/api/v1/devices', { connection: 'qr' }, { 'Idempotency-Key': key })).body.error).toBe('invalid_idempotency_key');
    }
  });
});

describe('sign-up links', () => {
  it('QR: opening the page does not use the link; the button connects, redirects and emits device.connected', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['device.connected']);
    const created = await api.call('POST', '/api/v1/connect-links', { type: 'qr', external_reference: 'cliente-77', return_url: 'https://integrador.example/vuelta?x=1', expires_in_minutes: 60 });
    expect(created.headers.get('cache-control')).toBe('no-store');
    const link = created.body.data;
    expect(link).toMatchObject({ id: 1, type: 'qr', status: 'pending', device_id: null, allowed_connection_types: null, provision_us_number: false, error_code: null, completed_at: null });
    expect(link.url).toMatch(new RegExp(`^${api.url}/connect/[A-Za-z0-9_-]{43}$`));
    expect(Date.parse(link.expires_at) - Date.parse(link.created_at)).toBe(60 * 60 * 1000);

    const shown = (await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data;
    expect(shown.url).toBeUndefined();
    expect(JSON.stringify((await api.call('GET', '/_sandbox/state')).body)).not.toContain(link.url.split('/connect/')[1]);

    // A preview opens it: nothing happens.
    const page = await visit(link.url);
    expect(page.status).toBe(200);
    expect(page.text).toContain('/start');
    expect(page.text).toContain("history.replaceState(null, '', '/connect/reopen')");
    expect(Object.fromEntries(['cache-control', 'referrer-policy', 'x-frame-options', 'x-robots-tag'].map((h) => [h, page.headers.get(h)]))).toEqual({
      'cache-control': 'no-store, private',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex',
    });
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/);
    expect((await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data.status).toBe('pending');
    expect((await visit(`${api.url}/connect/reopen`)).status).toBe(200);

    const done = await start(link.url);
    expect(done.status).toBe(303);
    const back = new URL(done.location!);
    const completed = (await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data;
    expect(completed).toMatchObject({ status: 'completed', device_id: expect.any(Number), completed_at: expect.any(String) });
    expect(Object.fromEntries(back.searchParams)).toEqual({ x: '1', connect_link_id: String(link.id), status: 'completed', device_id: String(completed.device_id) });

    const [event] = await receiver.waitFor(1);
    expect(event!.json.data).toMatchObject({ connect_link_id: link.id, device: { id: completed.device_id, connection: 'qr', external_reference: 'cliente-77' } });
    expect((await api.call('GET', `/api/v1/devices/${completed.device_id}`)).body).toMatchObject({ connected: 1, external_reference: 'cliente-77' });

    // One use only.
    expect((await visit(link.url)).status).toBe(410);
    expect((await start(link.url)).status).toBe(410);
  });

  it('a failed sign-up: the link ends failed and return_url gets the error_code', async () => {
    const api = await startSandbox();
    const link = await createLink(api, { type: 'qr', return_url: 'https://integrador.example/vuelta' });
    const done = await start(link.url, { outcome: 'failed' });
    expect(Object.fromEntries(new URL(done.location!).searchParams)).toEqual({ connect_link_id: String(link.id), status: 'failed', error_code: 'qr_timeout' });
    expect((await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data).toMatchObject({ status: 'failed', error_code: 'qr_timeout', device_id: null });
    expect((await api.call('GET', '/api/v1/devices')).body.meta.total).toBe(2);
  });

  it('Meta: the customer chooses the connection; the US pool has its limit; POST /complete works too', async () => {
    const api = await startSandbox({ numbers: { trial: true } });
    const both = await createLink(api, { type: 'meta', allowed_connection_types: ['coexistence', 'dedicated'] });
    expect((await visit(both.url)).text).toContain('name="connection"');
    const page = await start(both.url, { connection: 'dedicated' });
    expect(page.status).toBe(200);
    expect(page.text).toContain('connected');
    const dedicated = (await api.call('GET', `/api/v1/connect-links/${both.id}`)).body.data.device_id;
    expect((await api.call('GET', `/api/v1/devices/${dedicated}`)).body).toMatchObject({ provider: 2, connection: 'dedicated', connected: 1 });

    const pool = await createLink(api, { type: 'meta', allowed_connection_types: ['dedicated'], provision_us_number: true });
    await visit(`${pool.url}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const fromPool = (await api.call('GET', `/api/v1/connect-links/${pool.id}`)).body.data.device_id;
    expect((await api.call('GET', `/api/v1/devices/${fromPool}`)).body.number).toMatch(/^1555/);

    // A trial account gets one number of the pool.
    const second = await createLink(api, { type: 'meta', allowed_connection_types: ['dedicated'], provision_us_number: true });
    await start(second.url);
    expect((await api.call('GET', `/api/v1/connect-links/${second.id}`)).body.data).toMatchObject({ status: 'failed', error_code: 'trial_number_blocked' });
  });

  it('validates the body by type like accounts, and answers 503 while Meta is off', async () => {
    const api = await startSandbox({ numbers: { linksPerMinute: 100 } });
    const post = (body: Record<string, unknown>) => api.call('POST', '/api/v1/connect-links', body);
    const fields = async (body: Record<string, unknown>) => {
      const res = await post(body);
      expect(res.body.error, JSON.stringify(body)).toBe('invalid_request');
      return Object.keys(res.body.errors);
    };
    // Required and prohibited by type.
    expect(await fields({ type: 'meta' })).toEqual(['allowed_connection_types']);
    expect(await fields({ type: 'meta', allowed_connection_types: [] })).toEqual(['allowed_connection_types']);
    expect(await fields({ type: 'qr', allowed_connection_types: ['dedicated'], provision_us_number: false })).toEqual(['allowed_connection_types', 'provision_us_number']);
    expect(await fields({ type: 'meta', allowed_connection_types: ['dedicated'], same_number_as: 3 })).toEqual(['same_number_as']);
    expect(await fields({ type: 'qr', same_number_as: 3, device_id: 4 })).toEqual(['same_number_as']);
    // One or two distinct values, of the list.
    expect(await fields({ type: 'meta', allowed_connection_types: ['other'] })).toEqual(['allowed_connection_types.0']);
    expect(await fields({ type: 'meta', allowed_connection_types: ['dedicated', 'dedicated'] })).toEqual(['allowed_connection_types']);
    expect(await fields({ type: 'meta', allowed_connection_types: ['dedicated', 'coexistence', 'dedicated'] })).toEqual(['allowed_connection_types']);
    expect(await fields({ type: 'qr', return_url: 'http://localhost/vuelta' })).toEqual(['return_url']);
    expect(await fields({ type: 'qr', return_url: `https://x.example/${'a'.repeat(2048)}` })).toEqual(['return_url']);
    expect(await fields({ type: 'qr', expires_in_minutes: 20 })).toEqual(['expires_in_minutes']);
    expect(await fields({ type: 'whatsapp' })).toEqual(['type']);
    // What Laravel's prohibited lets through: null.
    expect((await post({ type: 'qr', allowed_connection_types: null, same_number_as: null, device_id: null })).status).toBe(201);
    expect((await post({ type: 'meta', allowed_connection_types: ['coexistence', 'dedicated'], provision_us_number: false })).status).toBe(201);

    expect((await post({ type: 'meta', allowed_connection_types: ['dedicated'], device_id: 4 })).body.error).toBe('connection_type_mismatch');
    expect((await post({ type: 'qr', device_id: 99 })).body.error).toBe('invalid_reference_device');
    expect((await post({ type: 'qr', same_number_as: 99 })).body.error).toBe('invalid_reference_device');

    await api.call('POST', '/_sandbox/numbers', { meta_connect: false });
    expect(await post({ type: 'meta', allowed_connection_types: ['dedicated'] })).toMatchObject({ status: 503, body: { error: 'meta_connect_disabled' } });
    expect((await post({ type: 'qr' })).status).toBe(201);
  });

  it('limits the creations per minute with the 429 of Laravel', async () => {
    const api = await startSandbox({ numbers: { linksPerMinute: 2 } });
    await createLink(api, { type: 'qr' });
    await createLink(api, { type: 'qr' });
    const third = await api.call('POST', '/api/v1/connect-links', { type: 'qr' });
    expect(third).toMatchObject({ status: 429, body: { message: 'Too Many Attempts.' } });
    expect(third.body.error).toBeUndefined();
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('revoke, expire, the open-link limit, the order and filters, and the page that refuses a key', async () => {
    const api = await startSandbox({ numbers: { linksPerMinute: 100 } });
    const a = await createLink(api, { type: 'qr', external_reference: 'r-1' });
    const b = await createLink(api, { type: 'qr' });
    expect((await api.call('DELETE', `/api/v1/connect-links/${a.id}`))).toMatchObject({ status: 204, body: null });
    expect((await api.call('DELETE', `/api/v1/connect-links/${a.id}`))).toMatchObject({ status: 409, body: { error: 'link_not_pending' } });
    expect((await api.call('DELETE', '/api/v1/connect-links/999')).status).toBe(404);
    expect((await api.call('GET', `/api/v1/connect-links/${a.id}`)).body.data).toMatchObject({ status: 'revoked', error_code: 'revoked' });
    expect((await visit(a.url)).status).toBe(410);

    api.sandbox.app.store.connectLinks.get(b.id)!.expiresAt = new Date(Date.now() - 1000);
    expect((await api.call('GET', `/api/v1/connect-links/${b.id}`)).body.data).toMatchObject({ status: 'expired', error_code: 'link_expired' });
    expect((await start(b.url)).status).toBe(410);

    expect((await api.call('GET', '/api/v1/connect-links')).body.data.map((l: { id: number }) => l.id)).toEqual([b.id, a.id]);
    expect((await api.call('GET', '/api/v1/connect-links?status=revoked')).body.data.map((l: { id: number }) => l.id)).toEqual([a.id]);
    expect((await api.call('GET', '/api/v1/connect-links?external_reference=r-1')).body.meta.total).toBe(1);

    for (let i = 0; i < 20; i++) await createLink(api, { type: 'qr', device_id: 4 });
    // Each reconnection link revokes the earlier one of the same number: only one is open.
    expect((await api.call('GET', '/api/v1/connect-links?status=pending')).body.meta.total).toBe(1);
    for (let i = 0; i < 19; i++) await createLink(api, { type: 'qr' });
    expect((await api.call('POST', '/api/v1/connect-links', { type: 'qr' }))).toMatchObject({ status: 429, body: { error: 'too_many_open_links' } });

    const withKey = await visit(`${api.url}/connect/whatever`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(withKey.status).toBe(403);
    expect(JSON.parse(withKey.text)).toMatchObject({ error: 'credentials_not_allowed' });
    expect((await visit(`${api.url}/connect/nope`)).status).toBe(404);
  });

  it('reconnects a number without taking a place', async () => {
    const api = await startSandbox({ numbers: { limit: 2 } });
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['device.connected', 'device.disconnected']);
    await api.call('POST', '/_sandbox/devices/4/disconnect');
    const link = await createLink(api, { type: 'qr', device_id: 4 });
    expect(link.device_id).toBe(4);
    await start(link.url);
    expect((await api.call('GET', '/api/v1/devices/4')).body.connected).toBe(1);
    const [off, on] = await receiver.waitFor(2);
    expect(off!.json.data).toMatchObject({ reason: 'qr_logged_out', device: { id: 4, connection: 'qr' }, connect_link_id: null });
    expect(on!.json.data).toMatchObject({ connect_link_id: link.id, device: { id: 4 } });
    expect((await api.call('GET', '/api/v1/devices')).body.meta.total).toBe(2);
  });
});

describe('device events', () => {
  it('the four carry connect_link_id: the link that connected the number last', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, DEVICE_EVENTS);
    const link = await createLink(api, { type: 'meta', allowed_connection_types: ['dedicated'], external_reference: 'r-9' });
    await start(link.url);
    const id = (await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data.device_id;
    await api.call('POST', `/_sandbox/devices/${id}/health`, { state: 'limited' });
    await api.call('POST', `/_sandbox/devices/${id}/disconnect`, { reason: 'disconnected_by_user' });
    // Connected again without a link: it keeps the last one.
    await api.call('POST', `/_sandbox/devices/${id}/connect`);
    await api.call('DELETE', `/api/v1/devices/${id}`);
    const deliveries = await receiver.waitFor(5);
    expect(deliveries.map((d) => [d.json.type, d.json.data.connect_link_id, d.json.data.device.external_reference])).toEqual([
      ['device.connected', link.id, 'r-9'],
      ['device.health_changed', link.id, 'r-9'],
      ['device.disconnected', link.id, 'r-9'],
      ['device.connected', link.id, 'r-9'],
      ['device.deleted', link.id, 'r-9'],
    ]);
    expect(deliveries[2]!.json.data.reason).toBe('disconnected_by_user');
    for (const d of deliveries) expect(Object.keys(d.json.data).at(-1)).toBe('connect_link_id');
  });

  it('disconnected carries a reason; health_changed only when the state changes', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, DEVICE_EVENTS);
    await api.call('POST', '/_sandbox/devices/3/disconnect', { reason: 'shadow_ban_protection' });
    expect((await api.call('POST', '/_sandbox/devices/3/disconnect', { reason: 'nope' })).status).toBe(422);
    await api.call('POST', '/_sandbox/devices/3/health', { state: 'limited' });
    const same = await api.call('POST', '/_sandbox/devices/3/health', { state: 'limited' });
    expect(same.body.event).toBeNull();
    expect((await api.call('POST', '/_sandbox/devices/4/health', { state: 'limited' })).status).toBe(422);
    const [off, health] = await receiver.waitFor(2);
    expect(off!.json.data).toMatchObject({ reason: 'shadow_ban_protection', device: { id: 3, connection: 'dedicated', external_reference: null }, connect_link_id: null });
    expect(health!.json).toMatchObject({ type: 'device.health_changed', data: { previous_state: 'available', state: 'limited', device: { id: 3 } } });
    expect((await api.call('GET', '/api/v1/devices/3')).body.health.state).toBe('limited');
  });

  it('the catalog emits the new shapes by default, connect_link_id included', async () => {
    const api = await startSandbox();
    for (const type of DEVICE_EVENTS) {
      const res = await api.call('POST', `/_sandbox/events/${type}`, {});
      expect(res.status, type).toBe(202);
      expect(res.body.data.device, type).toMatchObject({ connection: expect.any(String), external_reference: expect.anything() });
      expect(res.body.data, type).toHaveProperty('connect_link_id');
    }
  });
});
