/**
 * Subscriptions with the routes the SDKs use (`/api/v1/webhooks`), the test delivery, the history and the retries.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { startReceiver, startSandbox, subscribe, until } from './helpers.js';

describe('subscriptions', () => {
  it('create shows the secret once; reads never do', async () => {
    const api = await startSandbox();
    const created = await api.call('POST', '/api/v1/webhooks', { url: 'https://tu-servidor.example/hooks', events: ['message.received', 'message.status_changed'], description: 'Mi integración' });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_[A-Za-z0-9]{40}[0-9a-f]{8}$/);
    expect(created.body).toMatchObject({ url: 'https://tu-servidor.example/hooks', status: 'active', disabled_reason: null, filters: {}, migration: null, description: 'Mi integración' });
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);

    const shown = await api.call('GET', `/api/v1/webhooks/${created.body.id}`);
    expect(shown.body.secret).toBeUndefined();
    const list = await api.call('GET', '/api/v1/webhooks');
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body[0].secret).toBeUndefined();
    expect(JSON.stringify((await api.call('GET', '/_sandbox/state')).body)).not.toContain(created.body.secret);
    expect(JSON.stringify((await api.call('GET', '/_sandbox/requests')).body)).not.toContain(created.body.secret);
  });

  it('update keeps the secret; rotate gives a new one; delete answers 204', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    const sub = await subscribe(api, receiver.url, ['message.received']);
    const updated = await api.call('PUT', `/api/v1/webhooks/${sub.id}`, { url: receiver.url, events: ['message.received', 'contact.created'], status: 'paused' });
    expect(updated.body).toMatchObject({ status: 'paused', events: ['message.received', 'contact.created'] });
    const rotated = await api.call('POST', `/api/v1/webhooks/${sub.id}/rotate-secret`);
    expect(rotated.body.secret).not.toBe(sub.secret);
    expect((await api.call('DELETE', `/api/v1/webhooks/${sub.id}`)).status).toBe(204);
    expect((await api.call('GET', `/api/v1/webhooks/${sub.id}`)).body).toEqual({ error: 'not_found', message: 'Suscripción de webhook no encontrada.' });
  });

  it('a paused subscription receives nothing', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    const sub = await subscribe(api, receiver.url, ['message.received']);
    await api.call('PUT', `/api/v1/webhooks/${sub.id}`, { url: receiver.url, events: ['message.received'], status: 'paused' });
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received).toHaveLength(0);
  });

  it('validates url and events like accounts', async () => {
    const api = await startSandbox();
    const bad = await api.call('POST', '/api/v1/webhooks', { url: 'https://user:pass@example.com/h', events: ['message.received', 'nope', 'webhook.test'] });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual(['events.1', 'events.2', 'url']);
    expect((await api.call('POST', '/api/v1/webhooks', { url: 'https://example.com/h', events: [] })).body.errors.events).toBeDefined();
    const strict = await startSandbox({ webhooks: { requireHttps: true } });
    expect((await strict.call('POST', '/api/v1/webhooks', { url: 'http://localhost:3000/h', events: ['message.received'] })).body.errors.url).toEqual(['La URL del webhook debe ser https.']);
  });

  it('filters by campaign: an event of another campaign does not arrive', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await api.call('POST', '/api/v1/webhooks', { url: receiver.url, events: ['group.created'], filters: { campaign_ids: ['campana-a'] } });
    await api.call('POST', '/_sandbox/events/group.created', { data: { campaign: { uuid: 'campana-b' } } });
    await api.call('POST', '/_sandbox/events/group.created', { data: { campaign: { uuid: 'campana-a' } } });
    await receiver.waitFor(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(receiver.received.map((d) => d.json.data.campaign.uuid)).toEqual(['campana-a']);
  });

  it('the catalog has the shape of accounts', async () => {
    const api = await startSandbox();
    const res = await api.call('GET', '/api/v1/webhooks/events');
    expect(res.body.meta).toMatchObject({ envelope_version: 'v1', signature_header: 'X-Funnelchat-Signature' });
    const types = res.body.data.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(['message.received', 'message.status_changed', 'contact.created', 'device.connected', 'group_participant.joined', 'webhook.test']));
    const status = res.body.data.find((e: { type: string }) => e.type === 'message.status_changed');
    expect(status).toMatchObject({ area: 'conversations', status: 'planned', subscribable: true });
    expect(res.body.data.find((e: { type: string }) => e.type === 'webhook.test')).toMatchObject({ subscribable: false });
  });
});

describe('the test delivery and the history', () => {
  it('POST /webhooks/{id}/test delivers webhook.test once and answers its result', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver([500]);
    const sub = await subscribe(api, receiver.url, ['message.received']);
    const res = await api.call('POST', `/api/v1/webhooks/${sub.id}/test`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ succeeded: false, response_status: 500, error: 'non_2xx', duration_ms: expect.any(Number), delivery_id: expect.any(Number) });
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]!.json.data).toEqual({ subscription: sub.id, sent_at: expect.stringMatching(/Z$/) });
    // No retries for a test.
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received).toHaveLength(1);

    const history = await api.call('GET', `/api/v1/webhooks/${sub.id}/deliveries`);
    expect(history.body.data[0]).toEqual({
      id: res.body.delivery_id,
      event_id: receiver.received[0]!.json.id,
      event_type: 'webhook.test',
      attempt: 1,
      url: receiver.url,
      response_status: 500,
      succeeded: false,
      error: 'non_2xx',
      duration_ms: expect.any(Number),
      attempted_at: expect.stringMatching(/\+00:00$/),
    });
    expect(history.body.meta).toMatchObject({ current_page: 1, per_page: 25, total: 1 });
  });

  it('an unreachable receiver is connection_failed', async () => {
    const api = await startSandbox();
    const sub = await subscribe(api, 'http://127.0.0.1:9/hooks', ['message.received']);
    const res = await api.call('POST', `/api/v1/webhooks/${sub.id}/test`);
    expect(res.body).toMatchObject({ succeeded: false, response_status: null, error: 'connection_failed' });
  });
});

describe('retries', () => {
  it('a 5xx or a 429 is retried with the same event and the same bytes, a new delivery id each time', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver([500, 429, 200]);
    const sub = await subscribe(api, receiver.url, ['message.received']);
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    const attempts = await receiver.waitFor(3);
    expect(new Set(attempts.map((a) => a.json.id)).size).toBe(1);
    expect(new Set(attempts.map((a) => a.raw.toString('utf8'))).size).toBe(1);
    expect(new Set(attempts.map((a) => a.headers['x-funnelchat-delivery'])).size).toBe(3);

    await until(() => api.sandbox.app.store.deliveries.length === 3);
    const history = await api.call('GET', `/api/v1/webhooks/${sub.id}/deliveries`);
    expect(history.body.data.map((d: { attempt: number; response_status: number; succeeded: boolean }) => [d.attempt, d.response_status, d.succeeded])).toEqual([
      [3, 200, true],
      [2, 429, false],
      [1, 500, false],
    ]);
    expect((await api.call('GET', `/api/v1/webhooks/${sub.id}`)).body.last_success_at).not.toBeNull();
  });

  it('another 4xx is final: one attempt', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver([404]);
    await subscribe(api, receiver.url, ['message.received']);
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    await receiver.waitFor(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(receiver.received).toHaveLength(1);
  });

  it('gives up after 4 attempts and disables the subscription after N failed deliveries in a row', async () => {
    const api = await startSandbox({ webhooks: { maxConsecutiveFailures: 2 } });
    const receiver = await startReceiver([503]);
    const sub = await subscribe(api, receiver.url, ['message.received']);
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    await receiver.waitFor(4);
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received).toHaveLength(4);
    expect((await api.call('GET', `/api/v1/webhooks/${sub.id}`)).body.status).toBe('active');

    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    await receiver.waitFor(8);
    await until(() => api.sandbox.app.store.subscriptions.get(sub.id)?.status === 'disabled');
    expect((await api.call('GET', `/api/v1/webhooks/${sub.id}`)).body).toMatchObject({ status: 'disabled', disabled_reason: 'too_many_failures' });

    // Turning it back on clears the reason.
    const on = await api.call('PUT', `/api/v1/webhooks/${sub.id}`, { url: receiver.url, events: ['message.received'], status: 'active' });
    expect(on.body).toMatchObject({ status: 'active', disabled_reason: null });
  });

  it('a timeout counts as a failure and is retried', async () => {
    const api = await startSandbox({ webhooks: { timeoutSeconds: 0.05, retryDelays: [0.02] } });
    // A local receiver that never answers.
    const hanging = createServer(() => {});
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => {
      hanging.closeAllConnections();
      hanging.close();
    });
    const sub = await subscribe(api, `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/hooks`, ['message.received']);
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    await until(() => api.sandbox.app.store.deliveries.length === 2, 5000);
    const history = await api.call('GET', `/api/v1/webhooks/${sub.id}/deliveries`);
    expect(history.body.data.map((d: { error: string }) => d.error)).toEqual(['timeout', 'timeout']);
  });
});
