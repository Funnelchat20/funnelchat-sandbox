/**
 * Send → `queued` → `message.status_changed` (sent → delivered → read), and the forced failures.
 */
import { describe, expect, it } from 'vitest';
import { startReceiver, startSandbox, subscribe, until } from './helpers.js';

const PUBLIC_MESSAGE_KEYS = ['id', 'contact_id', 'device_id', 'direction', 'type', 'status', 'error', 'client_reference', 'created_at', 'updated_at'];

async function setup(config = {}) {
  const api = await startSandbox(config);
  const receiver = await startReceiver();
  await subscribe(api, receiver.url, ['message.status_changed']);
  return { api, receiver };
}

describe('sending with an API key', () => {
  it('answers the queued message at once and then announces sent, delivered and read', async () => {
    const { api, receiver } = await setup();
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 3 });

    const res = await api.call('POST', '/api/v1/contacts/2001/message', {
      device_id: 3,
      contact_id: 2001,
      phone: '5491100000000',
      text: '¡Hola! Te paso la info',
      client_reference: 'pedido-8841',
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['message']);
    expect(Object.keys(res.body.message)).toEqual(PUBLIC_MESSAGE_KEYS);
    expect(res.body.message).toMatchObject({ contact_id: 2001, device_id: 3, direction: 'outbound', type: 'text', status: 'queued', error: null, client_reference: 'pedido-8841' });
    const id = res.body.message.id;

    const events = await receiver.waitFor(3);
    expect(events.map((e) => [e.json.data.status, e.json.data.previous_status])).toEqual([
      ['sent', null],
      ['delivered', 'sent'],
      ['read', 'delivered'],
    ]);
    for (const e of events) {
      expect(e.json.type).toBe('message.status_changed');
      expect(Object.keys(e.json.data)).toEqual(['message_id', 'contact_id', 'device_id', 'status', 'previous_status', 'occurred_at', 'client_reference']);
      expect(e.json.data).toMatchObject({ message_id: id, contact_id: 2001, device_id: 3, client_reference: 'pedido-8841' });
    }
    expect(new Set(events.map((e) => e.json.id)).size).toBe(3);

    const lookup = await api.call('GET', `/api/v1/contacts/2001/messages/${id}`);
    expect(lookup.body).toMatchObject({ id, status: 'read', error: null });
    const history = await api.call('GET', '/api/v1/contacts/2001/messages');
    const row = history.body.data.find((m: { id: number }) => m.id === id);
    expect(row).toMatchObject({ own: 1, status: 2, client_reference: 'pedido-8841', text: '¡Hola! Te paso la info' });
  });

  it('never emits queued, and stops where the configuration says', async () => {
    const { api, receiver } = await setup({ statusDelays: { sent: 0.02, delivered: 0.02, read: null } });
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'Por QR, sin ventana' });
    expect(res.status).toBe(200);
    await receiver.waitFor(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received.map((e) => e.json.data.status)).toEqual(['sent', 'delivered']);
    expect((await api.call('GET', `/api/v1/contacts/2001/messages/${res.body.message.id}`)).body.status).toBe('delivered');
  });

  it('a note is stored with status null and is not sent', async () => {
    const { api, receiver } = await setup();
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 3, contact_id: 2001, text: 'Nota interna', note: true });
    expect(res.body.message).toMatchObject({ type: 'note', status: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received).toHaveLength(0);
  });

  it('send-message and send-template answer {message} too; a template needs no window', async () => {
    const { api, receiver } = await setup();
    const direct = await api.call('POST', '/api/v1/message/send-message', { device_id: 4, contact_id: 2001, text: 'Directo' });
    expect(direct.status).toBe(200);
    expect(direct.body.message.status).toBe('queued');

    const template = await api.call('POST', '/api/v1/devices/3/templates/45/send-template', {
      phone: '5491100000000',
      contact_id: 2001,
      template_variables: { body: ['Lucía'] },
      client_reference: 'bienvenida-1',
    });
    expect(template.status).toBe(200);
    expect(template.body.message).toMatchObject({ type: 'template', status: 'queued', device_id: 3, client_reference: 'bienvenida-1' });
    await receiver.waitFor(6);
    const history = await api.call('GET', '/api/v1/contacts/2001/messages');
    expect(history.body.data.find((m: { id: number }) => m.id === template.body.message.id).text).toBe('Hola Lucía, gracias por escribirnos. ¿En qué te podemos ayudar?');
  });

  it('cards answer one queued message per card, in order', async () => {
    const { api } = await setup();
    const other = await api.call('POST', '/api/v1/contacts', { phone: '5491100000055', name: 'Tarjeta' });
    const res = await api.call('POST', '/api/v1/contacts/2001/message/contact-card', { device_id: 4, contact_card_ids: [other.body.id, 2001], client_reference: 'tarjetas' });
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages.map((m: { type: string; status: string }) => [m.type, m.status])).toEqual([
      ['contact', 'queued'],
      ['contact', 'queued'],
    ]);
    expect(res.body.messages[0].id).not.toBe(res.body.messages[1].id);
  });
});

describe('forcing failures', () => {
  it('X-Sandbox-Fail with a reason of Funnelchat: one failed with previous_status null and error.reason', async () => {
    const { api, receiver } = await setup();
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'Sin saldo' }, { 'X-Sandbox-Fail': 'insufficient_balance' });
    expect(res.body.message.status).toBe('queued');
    const [event] = await receiver.waitFor(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received).toHaveLength(1);
    expect(event!.json.data).toMatchObject({ status: 'failed', previous_status: null, error: { code: null, reason: 'insufficient_balance' } });
    expect(typeof event!.json.data.error.title).toBe('string');
    expect(Object.keys(event!.json.data)).toEqual(['message_id', 'contact_id', 'device_id', 'status', 'previous_status', 'error', 'occurred_at', 'client_reference']);
    const lookup = await api.call('GET', `/api/v1/contacts/2001/messages/${res.body.message.id}`);
    expect(lookup.body.error).toEqual(event!.json.data.error);
  });

  it('X-Sandbox-Fail with a Meta code: sent, then failed with the code and title of Meta', async () => {
    const { api, receiver } = await setup();
    await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'Rechazado' }, { 'X-Sandbox-Fail': '131047' });
    const events = await receiver.waitFor(2);
    expect(events.map((e) => e.json.data.status)).toEqual(['sent', 'failed']);
    expect(events[1]!.json.data).toMatchObject({ previous_status: 'sent', error: { code: 131047, title: 'Re-engagement message', reason: null } });
  });

  it('X-Sandbox-Reject answers the error of the rule right away and stores nothing', async () => {
    const { api } = await setup();
    const before = (await api.call('GET', '/api/v1/contacts/2001/messages')).body.data.length;
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'x' }, { 'X-Sandbox-Reject': 'rate_limited' });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'rate_limited', message: expect.any(String) });
    expect(res.headers.get('retry-after')).toBe('6');
    expect((await api.call('GET', '/api/v1/contacts/2001/messages')).body.data.length).toBe(before);
  });

  it('POST /_sandbox/failures arms the next sends, also for templates', async () => {
    const { api, receiver } = await setup();
    const armed = await api.call('POST', '/_sandbox/failures', { mode: 'fail', code: 'window_closed', count: 1 });
    expect(armed.status).toBe(201);
    await api.call('POST', '/api/v1/devices/3/templates/45/send-template', { phone: '5491100000000', contact_id: 2001, template_variables: { body: ['Lucía'] } });
    const [event] = await receiver.waitFor(1);
    expect(event!.json.data).toMatchObject({ status: 'failed', error: { reason: 'window_closed' } });

    await api.call('POST', '/_sandbox/failures', { mode: 'reject', code: 'antiblock_unanswered_limit' });
    const rejected = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'otro' });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error).toBe('antiblock_unanswered_limit');
    // Used up: the next one goes out.
    expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'y otro' })).status).toBe(200);
  });

  it('rejects an unknown forced code with what is accepted', async () => {
    const { api } = await setup();
    const res = await api.call('POST', '/_sandbox/failures', { mode: 'reject', code: 'nope' });
    expect(res.status).toBe(422);
    expect(res.body.errors.code[0]).toContain('window_closed');
  });

  it('a manual transition via /_sandbox/messages/{id}/status never goes back', async () => {
    const { api, receiver } = await setup({ statusDelays: { sent: 60 } });
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'manual' });
    const id = res.body.message.id;
    expect((await api.call('POST', `/_sandbox/messages/${id}/status`, { status: 'read' })).status).toBe(200);
    expect((await api.call('POST', `/_sandbox/messages/${id}/status`, { status: 'delivered' })).status).toBe(409);
    await until(() => receiver.received.length === 1);
    expect(receiver.received[0]!.json.data).toMatchObject({ status: 'read', previous_status: null });
  });
});
