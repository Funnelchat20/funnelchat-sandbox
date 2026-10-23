/**
 * The sign-up of numbers by API (contract of 22-10, A1 and A3): a number by QR and its code, the quota, `same_number_as`,
 * `Idempotency-Key`, the sign-up links with their hosted page, and the four signed `device.*` events.
 */
import { describe, expect, it } from 'vitest';
import { signature } from '../src/webhooks/signature.js';
import { API_KEY, startReceiver, startSandbox, subscribe, type Api } from './helpers.js';

const DEVICE_EVENTS = ['device.connected', 'device.disconnected', 'device.deleted', 'device.health_changed'];

/** Opens the hosted page like a browser would, without following the redirect. */
async function open(url: string, init: RequestInit = {}): Promise<{ status: number; location: string | null; headers: Headers; text: string }> {
  const response = await fetch(url, { redirect: 'manual', ...init });
  return { status: response.status, location: response.headers.get('location'), headers: response.headers, text: await response.text() };
}

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
    expect((await api.call('GET', `/api/v1/devices/${device.id}/qr`)).body.data).toMatchObject({ connected: true, qr_code: null });

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

    expect((await api.call('DELETE', `/api/v1/devices/${device.id}`)).status).toBe(200);
    const deliveries = await receiver.waitFor(2);
    expect(deliveries[1]!.json).toMatchObject({ type: 'device.deleted', data: { device: { id: device.id, external_reference: 'cliente-9000', connection: 'qr' } } });
    expect((await api.call('GET', `/api/v1/devices/${device.id}`)).status).toBe(404);
    expect((await api.call('GET', '/_sandbox/numbers')).body).toMatchObject({ in_use: 2 });
  });

  it('applies the quota: a phone counts once, and the two 403', async () => {
    const api = await startSandbox({ numbers: { limit: 3 } });
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr' })).status).toBe(201);
    const full = await api.call('POST', '/api/v1/devices', { connection: 'qr' });
    expect(full).toMatchObject({ status: 403, body: { error: 'number_limit_reached', limit: 3 } });
    await api.call('POST', '/_sandbox/numbers', { included: false });
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr' })).body.error).toBe('numbers_not_included');
    expect((await api.call('POST', '/api/v1/devices', { connection: 'meta' })).status).toBe(422);
  });

  it('same_number_as: only on a number in coexistence without QR, and it takes no place', async () => {
    const api = await startSandbox({ numbers: { limit: 3 } });
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr', same_number_as: 3 })).body.error).toBe('qr_requires_coexistence');
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr', same_number_as: 4 })).body).toMatchObject({ error: 'method_already_present', device_id: 4 });

    const link = await createLink(api, { type: 'meta', allowed_connection_types: ['coexistence'] });
    await open(link.url);
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
  it('the same body gives back the same answer; another body answers 422; a rejection is not kept', async () => {
    const api = await startSandbox({ numbers: { limit: 2 } });
    const headers = { 'Idempotency-Key': 'alta-8841' };
    const rejected = await api.call('POST', '/api/v1/devices', { connection: 'qr' }, headers);
    expect(rejected.body.error).toBe('number_limit_reached');
    await api.call('POST', '/_sandbox/numbers', { limit: 10 });

    const first = await api.call('POST', '/api/v1/devices', { connection: 'qr', alias: 'A' }, headers);
    const again = await api.call('POST', '/api/v1/devices', { alias: 'A', connection: 'qr' }, headers);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect((await api.call('GET', '/api/v1/devices')).body.meta.total).toBe(3);

    const other = await api.call('POST', '/api/v1/devices', { connection: 'qr', alias: 'B' }, headers);
    expect(other).toMatchObject({ status: 422, body: { error: 'idempotency_key_mismatch' } });
    // Another route with the same key is another body.
    expect((await api.call('POST', '/api/v1/connect-links', { type: 'qr' }, headers)).body.error).toBe('idempotency_key_mismatch');

    const link = await api.call('POST', '/api/v1/connect-links', { type: 'qr' }, { 'Idempotency-Key': 'link-1' });
    const linkAgain = await api.call('POST', '/api/v1/connect-links', { type: 'qr' }, { 'Idempotency-Key': 'link-1' });
    expect(linkAgain.body.data).toEqual(link.body.data);
    expect((await api.call('POST', '/api/v1/devices', { connection: 'qr' }, { 'Idempotency-Key': 'x'.repeat(256) })).status).toBe(422);
  });
});

describe('sign-up links', () => {
  it('QR: the page connects at once, redirects to return_url and emits device.connected with the link', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['device.connected']);
    const link = await createLink(api, { type: 'qr', external_reference: 'cliente-77', return_url: 'https://integrador.example/vuelta?x=1', expires_in_minutes: 60 });
    expect(link).toMatchObject({ type: 'qr', status: 'pending', device_id: null, allowed_connection_types: null, provision_us_number: false, error_code: null, completed_at: null });
    expect(link.url).toMatch(new RegExp(`^${api.url}/connect/[A-Za-z0-9_-]{43}$`));
    expect(Date.parse(link.expires_at) - Date.parse(link.created_at)).toBe(60 * 60 * 1000);

    const shown = (await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data;
    expect(shown.url).toBeUndefined();
    expect(JSON.stringify((await api.call('GET', '/_sandbox/state')).body)).not.toContain(link.url.split('/connect/')[1]);

    const visit = await open(link.url);
    expect(visit.status).toBe(303);
    expect(visit.headers.get('cache-control')).toBe('no-store');
    const back = new URL(visit.location!);
    const done = (await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data;
    expect(done).toMatchObject({ status: 'completed', device_id: expect.any(Number), completed_at: expect.any(String) });
    expect(Object.fromEntries(back.searchParams)).toEqual({ x: '1', connect_link_id: link.id, status: 'completed', device_id: String(done.device_id) });

    const [event] = await receiver.waitFor(1);
    expect(event!.json.data).toMatchObject({ connect_link_id: link.id, device: { id: done.device_id, connection: 'qr', external_reference: 'cliente-77' } });
    expect((await api.call('GET', `/api/v1/devices/${done.device_id}`)).body).toMatchObject({ connected: 1, external_reference: 'cliente-77' });

    // One use only.
    expect((await open(link.url)).status).toBe(410);
  });

  it('a failed sign-up: the link ends failed and return_url gets the error_code', async () => {
    const api = await startSandbox();
    const link = await createLink(api, { type: 'qr', return_url: 'https://integrador.example/vuelta' });
    const visit = await open(`${link.url}?outcome=failed`);
    expect(Object.fromEntries(new URL(visit.location!).searchParams)).toEqual({ connect_link_id: link.id, status: 'failed', error_code: 'qr_timeout' });
    expect((await api.call('GET', `/api/v1/connect-links/${link.id}`)).body.data).toMatchObject({ status: 'failed', error_code: 'qr_timeout', device_id: null });
    expect((await api.call('GET', '/api/v1/devices')).body.meta.total).toBe(2);
  });

  it('Meta: the customer chooses the connection; the US pool has its limit; POST /complete works too', async () => {
    const api = await startSandbox({ numbers: { trial: true } });
    const both = await createLink(api, { type: 'meta', allowed_connection_types: ['coexistence', 'dedicated'] });
    const page = await open(`${both.url}?connection=dedicated`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('connected');
    const dedicated = (await api.call('GET', `/api/v1/connect-links/${both.id}`)).body.data.device_id;
    expect((await api.call('GET', `/api/v1/devices/${dedicated}`)).body).toMatchObject({ provider: 2, connection: 'dedicated', connected: 1 });

    const pool = await createLink(api, { type: 'meta', allowed_connection_types: ['dedicated'], provision_us_number: true });
    await open(`${pool.url}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const fromPool = (await api.call('GET', `/api/v1/connect-links/${pool.id}`)).body.data.device_id;
    expect((await api.call('GET', `/api/v1/devices/${fromPool}`)).body.number).toMatch(/^1555/);

    // A trial account gets one number of the pool.
    const second = await createLink(api, { type: 'meta', allowed_connection_types: ['dedicated'], provision_us_number: true });
    await open(second.url);
    expect((await api.call('GET', `/api/v1/connect-links/${second.id}`)).body.data).toMatchObject({ status: 'failed', error_code: 'trial_number_blocked' });
  });

  it('validates the body like the contract, and answers 503 while Meta is off', async () => {
    const api = await startSandbox();
    const errors = async (body: Record<string, unknown>) => (await api.call('POST', '/api/v1/connect-links', body)).body.errors ?? {};
    expect(Object.keys(await errors({ type: 'meta' }))).toEqual(['allowed_connection_types']);
    expect(Object.keys(await errors({ type: 'qr', allowed_connection_types: ['dedicated'], provision_us_number: true }))).toEqual(['allowed_connection_types', 'provision_us_number']);
    expect(Object.keys(await errors({ type: 'qr', return_url: 'http://localhost/vuelta' }))).toEqual(['return_url']);
    expect(Object.keys(await errors({ type: 'qr', expires_in_minutes: 20 }))).toEqual(['expires_in_minutes']);
    expect(Object.keys(await errors({ type: 'meta', allowed_connection_types: ['dedicated'], device_id: 4 }))).toEqual(['device_id']);
    expect(Object.keys(await errors({ type: 'meta', allowed_connection_types: ['other'] }))).toEqual(['allowed_connection_types.0']);

    await api.call('POST', '/_sandbox/numbers', { meta_connect: false });
    const off = await api.call('POST', '/api/v1/connect-links', { type: 'meta', allowed_connection_types: ['dedicated'] });
    expect(off).toMatchObject({ status: 503, body: { error: 'meta_connect_disabled' } });
    expect((await api.call('POST', '/api/v1/connect-links', { type: 'qr' })).status).toBe(201);
  });

  it('revoke, expire, the open-link limit, the filters and the page that refuses a key', async () => {
    const api = await startSandbox();
    const a = await createLink(api, { type: 'qr', external_reference: 'r-1' });
    const b = await createLink(api, { type: 'qr' });
    expect((await api.call('DELETE', `/api/v1/connect-links/${a.id}`)).status).toBe(204);
    expect((await api.call('DELETE', `/api/v1/connect-links/${a.id}`))).toMatchObject({ status: 409, body: { error: 'link_not_pending' } });
    expect((await open(a.url)).status).toBe(410);

    api.sandbox.app.store.connectLinks.get(b.id)!.expiresAt = new Date(Date.now() - 1000);
    expect((await api.call('GET', `/api/v1/connect-links/${b.id}`)).body.data).toMatchObject({ status: 'expired', error_code: 'link_expired' });
    expect((await open(b.url)).status).toBe(410);

    expect((await api.call('GET', '/api/v1/connect-links?status=revoked')).body.data.map((l: { id: string }) => l.id)).toEqual([a.id]);
    expect((await api.call('GET', '/api/v1/connect-links?external_reference=r-1')).body.meta.total).toBe(1);

    for (let i = 0; i < 20; i++) await createLink(api, { type: 'qr', device_id: 4 });
    // Each reconnection link revokes the earlier one of the same number: only one is open.
    expect((await api.call('GET', '/api/v1/connect-links?status=pending')).body.meta.total).toBe(1);
    for (let i = 0; i < 19; i++) await createLink(api, { type: 'qr' });
    expect((await api.call('POST', '/api/v1/connect-links', { type: 'qr' }))).toMatchObject({ status: 429, body: { error: 'too_many_open_links' } });

    const withKey = await open(`${api.url}/connect/whatever`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(withKey.status).toBe(403);
    expect((await open(`${api.url}/connect/nope`)).status).toBe(404);
  });

  it('reconnects a number without taking a place', async () => {
    const api = await startSandbox({ numbers: { limit: 2 } });
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['device.connected', 'device.disconnected']);
    await api.call('POST', '/_sandbox/devices/4/disconnect');
    const link = await createLink(api, { type: 'qr', device_id: 4 });
    expect(link.device_id).toBe(4);
    await open(link.url);
    expect((await api.call('GET', '/api/v1/devices/4')).body.connected).toBe(1);
    const [off, on] = await receiver.waitFor(2);
    expect(off!.json.data).toMatchObject({ reason: 'qr_logged_out', device: { id: 4, connection: 'qr' } });
    expect(on!.json.data).toMatchObject({ connect_link_id: link.id, device: { id: 4 } });
    expect((await api.call('GET', '/api/v1/devices')).body.meta.total).toBe(2);
  });
});

describe('device events', () => {
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
    expect(off!.json.data).toMatchObject({ reason: 'shadow_ban_protection', device: { id: 3, connection: 'dedicated', external_reference: null } });
    expect(health!.json).toMatchObject({ type: 'device.health_changed', data: { previous_state: 'available', state: 'limited', device: { id: 3 } } });
    expect((await api.call('GET', '/api/v1/devices/3')).body.health.state).toBe('limited');
  });

  it('the catalog emits the new shapes by default', async () => {
    const api = await startSandbox();
    for (const type of DEVICE_EVENTS) {
      const res = await api.call('POST', `/_sandbox/events/${type}`, {});
      expect(res.status, type).toBe(202);
      expect(res.body.data.device, type).toMatchObject({ connection: expect.any(String), external_reference: expect.anything() });
    }
  });
});
