/**
 * What comes from WhatsApp or the panel, simulated through /_sandbox: incoming messages, groups, tags, numbers,
 * any event of the catalog, and the reset.
 */
import { describe, expect, it } from 'vitest';
import { startReceiver, startSandbox, subscribe } from './helpers.js';

describe('POST /_sandbox/inbound/message', () => {
  it('a new phone creates the contact (contact.created) and emits message.received with the shape of the API', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['contact.created', 'message.received']);

    const res = await api.call('POST', '/_sandbox/inbound/message', { phone: '+54 9 11 5555-0001', name: 'Lucía', device_id: 3, text: 'Hola, ¿tienen stock?' });
    expect(res.status).toBe(201);
    expect(res.body.window).toEqual({ device_id: 3, is_open: true });

    const [created, received] = await receiver.waitFor(2);
    expect(created!.json.type).toBe('contact.created');
    expect(created!.json.data).toEqual({ contact: { id: res.body.contact.id, name: 'Lucía', phone: '+5491155550001', email: null } });
    expect(received!.json.type).toBe('message.received');
    expect(received!.json.data).toEqual({
      message: { id: res.body.message.id, type: 'text', text: 'Hola, ¿tienen stock?', media: null },
      contact: { id: res.body.contact.id, name: 'Lucía', phone: '+5491155550001' },
      receiver: { phone: '+5491100000001' },
      device_id: 3,
    });
    // The API stores the phone without `+`.
    expect(res.body.contact.phone).toBe('5491155550001');
  });

  it('an existing phone reuses the contact and does not emit contact.created', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['contact.created', 'message.received']);
    const res = await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000' });
    expect(res.body.contact.id).toBe(2001);
    await receiver.waitFor(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(receiver.received.map((d) => d.json.type)).toEqual(['message.received']);
  });

  it('a file arrives as media', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['message.received']);
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000', type: 'image', file: 'https://example.com/foto.jpg', text: null });
    const [d] = await receiver.waitFor(1);
    expect(d!.json.data.message).toEqual({ id: expect.any(Number), type: 'image', text: null, media: { file: 'https://example.com/foto.jpg' } });
  });

  it('the message shows up in the history, in the conversations and as unread', async () => {
    const api = await startSandbox();
    await api.call('POST', '/_sandbox/inbound/message', { phone: '5491100000000', text: 'Hola' });
    const history = await api.call('GET', '/api/v1/contacts/2001/messages');
    expect(history.body.data[0]).toMatchObject({ own: 0, text: 'Hola', status: 1 });
    expect((await api.call('GET', '/api/v1/conversations/count/unread')).body).toEqual({ count: 1 });
    const conversations = await api.call('GET', '/api/v1/conversations');
    expect(conversations.body.data.map((c: { id: number }) => c.id)).toEqual([2001]);
    expect((await api.call('POST', '/api/v1/conversations/mark-all-read')).body.updated_count).toBe(1);
  });

  it('needs a phone or a contact', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/_sandbox/inbound/message', { text: 'hola' });
    expect(res.status).toBe(422);
    expect(res.body.errors.phone).toBeDefined();
  });
});

describe('other simulated events', () => {
  it('group_participant.joined and .left', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['group_participant.joined', 'group_participant.left']);
    await api.call('POST', '/_sandbox/groups/participant-joined', { group: { uid: '120363000000000099@g.us', name: 'Clientes VIP' }, participant: { phone: '5491100000044', name: 'Ana' } });
    await api.call('POST', '/_sandbox/groups/participant-left', { participant: { phone: '5491100000044' } });
    const [joined, left] = await receiver.waitFor(2);
    expect(joined!.json).toMatchObject({
      type: 'group_participant.joined',
      data: { group: { uid: '120363000000000099@g.us', name: 'Clientes VIP' }, participant: { identity: '5491100000044', identity_type: 'phone', name: 'Ana' } },
    });
    expect(left!.json.type).toBe('group_participant.left');
    expect(left!.json.data.campaign).toEqual({ uuid: 'xK9mQz' });
  });

  it('any event of the catalog, from its example, with your changes', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['group.created']);
    const res = await api.call('POST', '/_sandbox/events/group.created', { data: { group: { name: 'Lanzamiento' } } });
    expect(res.status).toBe(202);
    const [d] = await receiver.waitFor(1);
    expect(d!.json.data.group).toEqual({ uid: '120363000000000000@g.us', name: 'Lanzamiento', type: 'group' });
    expect((await api.call('POST', '/_sandbox/events/nope.nope')).status).toBe(404);
    expect((await api.call('POST', '/_sandbox/events/webhook.test')).status).toBe(422);
  });

  it('tags of a contact emit contact.tag_added and contact.tag_removed', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['contact.tag_added', 'contact.tag_removed']);
    await api.call('POST', '/_sandbox/contacts/2001/tags', { tag_id: 4001 });
    expect((await api.call('GET', '/api/v1/contacts/2001/tags')).body.data.map((t: { id: number }) => t.id)).toEqual([4001]);
    expect((await api.call('GET', '/api/v1/contacts?tag_ids[]=4001&tag_mode=any')).body.meta.total).toBe(1);
    await api.call('DELETE', '/_sandbox/contacts/2001/tags/4001');
    const [added, removed] = await receiver.waitFor(2);
    expect(added!.json.data).toEqual({ contact: { id: 2001, name: 'Contacto de ejemplo', phone: '+5491100000000' }, tag: { id: 4001, name: 'Cliente' }, source: 'manual' });
    expect(removed!.json.type).toBe('contact.tag_removed');
  });

  it('a number that disconnects emits device.disconnected', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['device.disconnected', 'device.connected']);
    await api.call('POST', '/_sandbox/devices/4/disconnect');
    await api.call('POST', '/_sandbox/devices/4/connect');
    const [off, on] = await receiver.waitFor(2);
    expect(off!.json.data).toMatchObject({ device: { id: 4, name: 'Número QR de ejemplo', number: '5491100000002' } });
    expect(on!.json.type).toBe('device.connected');
  });

  it('a template created through the API is approved after a while: template.status_changed', async () => {
    const api = await startSandbox({ templateApprovalSeconds: 0.05 });
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['template.status_changed']);
    const created = await api.call('POST', '/api/v1/templates', { name: 'promo_octubre', language_code: 'es', category: 'MARKETING', type: 'text', body: 'Hola {{1}}' });
    expect(created.body.status).toBe('PENDING');
    const [d] = await receiver.waitFor(1);
    expect(d!.json.data).toMatchObject({ template: { id: created.body.id, name: 'promo_octubre' }, previous_status: 'PENDING', status: 'APPROVED', reason: null });
  });

  it('POST /_sandbox/reset empties the state and keeps the examples', async () => {
    const api = await startSandbox();
    await api.call('POST', '/api/v1/contacts', { phone: '5491100000123' });
    await api.call('POST', '/api/v1/webhooks', { url: 'http://127.0.0.1:9/x', events: ['message.received'] });
    const res = await api.call('POST', '/_sandbox/reset');
    expect(res.body.counts).toMatchObject({ contacts: 1, subscriptions: 0, messages: 0 });
    expect((await api.call('GET', '/api/v1/contacts')).body.data.map((c: { id: number }) => c.id)).toEqual([2001]);
  });
});
