/**
 * Subscriptions with the routes the SDKs use (`/api/v1/webhooks`), the catalog, the events as the spec types them, the
 * test delivery, the history and the retries.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { spec } from '../src/openapi/spec.js';
import { conforms } from '../src/openapi/validate.js';
import { startReceiver, startSandbox, subscribe, until } from './helpers.js';

/** The `data` schema of an event in the spec the sandbox serves. */
const eventData = (type: string): any => (spec.webhooks[type]?.post?.requestBody?.content?.['application/json']?.schema as any).properties.data;

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

  it('update keeps the secret; rotate-secret is not published; delete answers 204', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    const sub = await subscribe(api, receiver.url, ['message.received']);
    const updated = await api.call('PUT', `/api/v1/webhooks/${sub.id}`, { url: receiver.url, events: ['message.received', 'contact.created'], status: 'paused' });
    expect(updated.body).toMatchObject({ status: 'paused', events: ['message.received', 'contact.created'] });
    // The secret is rotated from the panel: the published spec does not carry the route.
    expect((await api.call('POST', `/api/v1/webhooks/${sub.id}/rotate-secret`)).body.error).toBe('route_not_found');
    expect((await api.call('DELETE', `/api/v1/webhooks/${sub.id}`)).status).toBe(204);
    // accounts answers `{message}` without `error`.
    expect((await api.call('GET', `/api/v1/webhooks/${sub.id}`)).body).toEqual({ message: 'Suscripción de webhook no encontrada.' });
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

  it('the catalog is the spec\'s: the events enum of POST /webhooks, then webhook.test, each as the spec documents it', async () => {
    const api = await startSandbox();
    const res = await api.call('GET', '/api/v1/webhooks/events');
    const subscribable = (spec.components as any).schemas.StoreWebhookSubscriptionRequest.properties.events.items.enum;
    const types = res.body.data.map((e: { type: string }) => e.type);
    expect(types).toEqual([...subscribable, 'webhook.test']);
    expect(res.body.meta).toMatchObject({ total: 56, active: 56, envelope_version: 'v1', signature_header: 'X-Funnelchat-Signature' });
    expect(types).toEqual(expect.arrayContaining(['contact.updated', 'message.reaction_failed']));
    for (const gone of ['ai_quota.low_balance', 'ai_quota.topup_succeeded', 'ai_quota.topup_failed', 'billing.plan_blocked', 'subscription.expiring']) {
      expect(types).not.toContain(gone);
    }
    expect(Object.keys(res.body.data[0])).toEqual(['type', 'area', 'status', 'description', 'subscribable', 'example']);
    expect(res.body.data.find((e: { type: string }) => e.type === 'contact.updated')).toMatchObject({ area: 'conversations', status: 'active', subscribable: true });
    expect(res.body.data.find((e: { type: string }) => e.type === 'webhook.test')).toMatchObject({ area: 'accounts', subscribable: false });
    // Every example is its type's envelope and says its workspace: the API's fictitious 37.
    for (const entry of res.body.data) expect(entry.example, entry.type).toMatchObject({ type: entry.type, data: { workspace_id: 37 } });
  });

  it('subscribes to contact.updated and message.reaction_failed, and not to types the spec does not publish', async () => {
    const api = await startSandbox();
    const created = await api.call('POST', '/api/v1/webhooks', { url: 'https://example.com/h', events: ['contact.updated', 'message.reaction_failed'] });
    expect(created.status).toBe(201);
    for (const type of ['ai_quota.low_balance', 'billing.plan_blocked', 'subscription.expiring']) {
      expect((await api.call('POST', '/api/v1/webhooks', { url: 'https://example.com/h', events: [type] })).status, type).toBe(422);
      expect((await api.call('POST', `/_sandbox/events/${type}`)).status, type).toBe(404);
    }
  });
});

describe('the events, as the spec the sandbox serves types them', () => {
  it('message.received with a type the spec does not list goes out, and the spec accepts it', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['message.received']);
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 3, type: 'a_new_type', text: 'Hola' });
    const [d] = await receiver.waitFor(1);
    expect(d!.json.data.message.type).toBe('a_new_type');
    expect(conforms(eventData('message.received'), d!.json.data)).toBe(true);
  });

  it('whatsapp_form.completed: `label` is always a string, `value` may be null', () => {
    const answer = eventData('whatsapp_form.completed').properties.answers.items;
    expect(conforms(answer, { key: 'comentarios', label: 'comentarios', value: null })).toBe(true);
    expect(conforms(answer, { key: 'comentarios', label: null, value: 'Hola' })).toBe(false);
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
    expect(receiver.received[0]!.json.data).toEqual({ subscription: sub.id, sent_at: expect.stringMatching(/Z$/), workspace_id: 1 });
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
