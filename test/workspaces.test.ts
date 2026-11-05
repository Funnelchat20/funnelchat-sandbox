/**
 * Workspaces, as production confines API keys since 04-11 (accounts v1.5.97, conversations v1.19.7, communities
 * v2.35.5): each key sees and creates only in its workspace, and every event says which workspace it belongs to.
 */
import { describe, expect, it } from 'vitest';
import { startReceiver, startSandbox, subscribe, type Api } from './helpers.js';

/** A second workspace and its key, through the sandbox's own route. */
async function secondWorkspace(api: Api): Promise<{ id: number; key: string; as: (method: string, path: string, body?: unknown) => ReturnType<Api['call']> }> {
  const res = await api.call('POST', '/_sandbox/workspaces', { name: 'Cliente B' });
  expect(res.status).toBe(201);
  const { workspace, key } = res.body;
  return { id: workspace.id, key, as: (method, path, body) => api.call(method, path, body, { Authorization: `Bearer ${key}` }) };
}

describe('one workspace, as every account starts', () => {
  it('any well-formed key is the default workspace, and the events say it', async () => {
    const api = await startSandbox();
    const workspaces = await api.call('GET', '/_sandbox/workspaces');
    expect(workspaces.body.data).toEqual([{ id: 1, name: 'Principal', is_default: true, keys: [] }]);

    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['device.connected']);
    const device = await api.call('POST', '/api/v1/devices', { connection: 'qr' });
    await api.call('POST', `/_sandbox/devices/${device.body.data.id}/connect`);
    const [event] = await receiver.waitFor(1);
    // accounts `EventWorkspaceRouting::stamp()`: the last key of `data`.
    expect(Object.keys(event!.json.data)).toEqual(['device', 'connected_at', 'connect_link_id', 'workspace_id']);
    expect(event!.json.data.workspace_id).toBe(1);
    expect(event!.json.data.connected_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  });
});

describe('a key of another workspace', () => {
  it('neither sees nor changes the numbers, links and subscriptions of the default one', async () => {
    const api = await startSandbox();
    const b = await secondWorkspace(api);
    const receiver = await startReceiver();
    const subA = await subscribe(api, receiver.url, ['device.connected']);

    expect((await b.as('GET', '/api/v1/devices')).body.data).toEqual([]);
    expect(await b.as('GET', '/api/v1/devices/3')).toMatchObject({ status: 404, body: { message: 'Not Found' } });
    expect((await b.as('DELETE', '/api/v1/devices/4')).status).toBe(404);
    expect((await b.as('GET', '/api/v1/webhooks')).body).toEqual([]);
    expect((await b.as('GET', `/api/v1/webhooks/${subA.id}`)).status).toBe(404);
    expect((await b.as('DELETE', `/api/v1/webhooks/${subA.id}`)).status).toBe(404);

    const linkA = await api.call('POST', '/api/v1/connect-links', { type: 'qr' });
    expect((await b.as('GET', '/api/v1/connect-links')).body.data).toEqual([]);
    expect((await b.as('GET', `/api/v1/connect-links/${linkA.body.data.id}`)).status).toBe(404);
    // A number it does not see is not a valid reference.
    expect(await b.as('POST', '/api/v1/connect-links', { type: 'qr', device_id: 4 })).toMatchObject({ status: 422, body: { error: 'invalid_reference_device' } });
  });

  it('what it creates lands in its workspace, and only its subscriptions get those events', async () => {
    const api = await startSandbox();
    const b = await secondWorkspace(api);
    const receiverA = await startReceiver();
    const receiverB = await startReceiver();
    await subscribe(api, receiverA.url, ['device.connected']);
    const subB = await b.as('POST', '/api/v1/webhooks', { url: receiverB.url, events: ['device.connected'] });
    expect(subB.status).toBe(201);

    const device = await b.as('POST', '/api/v1/devices', { connection: 'qr' });
    const id = device.body.data.id;
    expect((await b.as('GET', '/api/v1/devices')).body.data.map((d: { id: number }) => d.id)).toEqual([id]);
    expect((await api.call('GET', `/api/v1/devices/${id}`)).status).toBe(404);
    expect((await api.call('GET', '/api/v1/devices')).body.data.map((d: { id: number }) => d.id)).toEqual([3, 4]);

    await api.call('POST', `/_sandbox/devices/${id}/connect`);
    const [connected] = await receiverB.waitFor(1);
    expect(connected!.json.data.workspace_id).toBe(b.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(receiverA.received).toHaveLength(0);

    // The test delivery says the workspace of the subscription.
    await b.as('POST', `/api/v1/webhooks/${subB.body.id}/test`);
    expect(receiverB.received.at(-1)!.json.data.workspace_id).toBe(b.id);
  });

  it('a link of the workspace creates the number there', async () => {
    const api = await startSandbox();
    const b = await secondWorkspace(api);
    const link = await b.as('POST', '/api/v1/connect-links', { type: 'qr' });
    const done = await fetch(`${link.body.data.url}/start`, { method: 'POST', headers: { Accept: 'application/json' }, redirect: 'manual' });
    expect(done.status).toBeLessThan(400);
    const devices = (await b.as('GET', '/api/v1/devices')).body.data;
    expect(devices).toHaveLength(1);
    expect((await api.call('GET', `/api/v1/devices/${devices[0].id}`)).status).toBe(404);
  });

  it('X-Workspace-Id does not switch workspace', async () => {
    const api = await startSandbox();
    const b = await secondWorkspace(api);
    const res = await api.call('GET', '/api/v1/devices', undefined, { Authorization: `Bearer ${b.key}`, 'X-Workspace-Id': '1' });
    expect(res.body.data).toEqual([]);
  });
});

describe('contacts, conversations and messages of another workspace', () => {
  it('a key of B neither lists nor reaches the contacts and messages of the default workspace: conversations answers 404 {message: ""}', async () => {
    const api = await startSandbox();
    const b = await secondWorkspace(api);
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 4, text: 'Hola' });

    expect((await b.as('GET', '/api/v1/contacts')).body.data).toEqual([]);
    expect((await b.as('GET', '/api/v1/conversations')).body.data).toEqual([]);
    expect((await b.as('GET', '/api/v1/conversations/count/all')).body).toEqual({ count: 0 });
    expect(await b.as('GET', '/api/v1/contacts/2001')).toMatchObject({ status: 404, body: { message: '' } });
    expect(await b.as('GET', '/api/v1/contacts/2001/messages/9001')).toMatchObject({ status: 404, body: { message: '' } });
    expect(await b.as('GET', '/api/v1/contacts/2001/messages')).toMatchObject({ status: 404, body: { message: 'Contacto no encontrado.' } });
    expect(await b.as('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'x' })).toMatchObject({ status: 404, body: { message: '' } });
    expect(await b.as('POST', '/api/v1/message/send-message', { device_id: 4, contact_id: 2001, text: 'x' })).toMatchObject({
      status: 404,
      body: { status: 'error', error: 'Contacto no encontrado.' },
    });
    expect((await b.as('GET', '/api/v1/templates')).body.data).toEqual([]);
  });

  it('a contact a key creates lands in its workspace; the phone stays unique in the account', async () => {
    const api = await startSandbox();
    const b = await secondWorkspace(api);
    const created = await b.as('POST', '/api/v1/contacts', { name: 'Ana', phone: '5491155550000' });
    expect(created.status).toBe(201);
    expect((await b.as('GET', '/api/v1/contacts')).body.data.map((c: { id: number }) => c.id)).toEqual([created.body.id]);
    expect((await api.call('GET', `/api/v1/contacts/${created.body.id}`)).status).toBe(404);
    // `ContactService::firstOrCreate`: the same phone again is the same contact, `200`.
    const again = await b.as('POST', '/api/v1/contacts', { phone: '5491155550000' });
    expect(again).toMatchObject({ status: 200, body: { id: created.body.id } });
  });

  it('a send through a number of the default workspace answers 404; through its own number the statuses go to its subscriptions', async () => {
    const api = await startSandbox();
    const b = await secondWorkspace(api);
    const contact = await b.as('POST', '/api/v1/contacts', { phone: '5491155550000' });
    expect(await b.as('POST', `/api/v1/contacts/${contact.body.id}/message`, { device_id: 4, contact_id: contact.body.id, text: 'x' })).toMatchObject({
      status: 404,
      body: { message: '' },
    });

    const receiver = await startReceiver();
    await b.as('POST', '/api/v1/webhooks', { url: receiver.url, events: ['message.status_changed'] });
    const device = await b.as('POST', '/api/v1/devices', { connection: 'qr' });
    await api.call('POST', `/_sandbox/devices/${device.body.data.id}/connect`);
    const sent = await b.as('POST', `/api/v1/contacts/${contact.body.id}/message`, { device_id: device.body.data.id, contact_id: contact.body.id, text: 'Hola' });
    expect(sent.status).toBe(200);
    const events = await receiver.waitFor(3);
    expect(events.map((e) => [e.json.data.status, e.json.data.workspace_id])).toEqual([
      ['sent', b.id],
      ['delivered', b.id],
      ['read', b.id],
    ]);
  });
});

describe('sending by phone, without contact_id (conversations v1.19.21)', () => {
  it('finds or creates the contact in the key\'s workspace; another workspace\'s phone is 404; whatsapp_id only on an official number', async () => {
    const api = await startSandbox();
    const sent = await api.call('POST', '/api/v1/message/send-message', { device_id: 4, phone: '+54 9 11 5555-0100', text: 'Hola' });
    expect(sent.status).toBe(200);
    const contactId = sent.body.message.contact_id as number;
    expect((await api.call('GET', `/api/v1/contacts/${contactId}`)).body.phone).toBe('5491155550100');
    // The same phone again is the same contact.
    expect((await api.call('POST', '/api/v1/message/send-message', { device_id: 4, phone: '5491155550100', text: 'Otra vez' })).body.message.contact_id).toBe(contactId);
    const template = await api.call('POST', '/api/v1/devices/3/templates/45/send-template', { phone: '5491155550100', template_variables: { body: ['Ana'] } });
    expect(template.body.message.contact_id).toBe(contactId);

    const b = await secondWorkspace(api);
    expect(await b.as('POST', '/api/v1/message/send-message', { device_id: 4, phone: '5491155550100', text: 'x' })).toMatchObject({ status: 404 });
    expect((await api.call('POST', '/api/v1/message/send-message', { device_id: 4, whatsapp_id: 'US.13491208655302741918', text: 'x' })).body.errors.whatsapp_id).toBeDefined();
    expect((await api.call('POST', '/api/v1/message/send-message', { device_id: 4, contact_id: 2001, phone: '5491155550100', text: 'x' })).body.error).toBe('recipient_mismatch');
  });
});

describe('events fired from /_sandbox', () => {
  it('go to the default workspace, or to the one named in the body', async () => {
    const api = await startSandbox();
    const b = await secondWorkspace(api);
    const receiverB = await startReceiver();
    await b.as('POST', '/api/v1/webhooks', { url: receiverB.url, events: ['mac.usage_80'] });

    const toDefault = await api.call('POST', '/_sandbox/events/mac.usage_80');
    expect(toDefault.body.event.subscriptions).toBe(0);
    expect(toDefault.body.data.workspace_id).toBe(1);

    const toB = await api.call('POST', '/_sandbox/events/mac.usage_80', { workspace_id: b.id });
    expect(toB.body.event.subscriptions).toBe(1);
    const [event] = await receiverB.waitFor(1);
    expect(event!.json.data).toEqual({ used: 8000, limit: 10000, percentage: 80, cycle_started_at: '2026-10-01T00:00:00Z', workspace_id: b.id });
  });

  it('every emitted event is listed, delivered or not', async () => {
    const api = await startSandbox();
    await api.call('POST', '/_sandbox/events/mac.usage_80');
    const emitted = await api.call('GET', '/_sandbox/emitted');
    expect(emitted.body.data[0]).toMatchObject({ type: 'mac.usage_80', subscriptions: 0, data: { workspace_id: 1 } });
  });
});

describe('configuration', () => {
  it('creates workspaces with fixed keys', async () => {
    const api = await startSandbox({ workspaces: [{ name: 'Cliente B', keys: ['7|fc_live_clienteB'] }] });
    const res = await api.call('POST', '/api/v1/devices', { connection: 'qr' }, { Authorization: 'Bearer 7|fc_live_clienteB' });
    expect(res.status).toBe(201);
    expect((await api.call('GET', '/api/v1/devices')).body.data.map((d: { id: number }) => d.id)).toEqual([3, 4]);
    const workspaces = await api.call('GET', '/_sandbox/workspaces');
    expect(workspaces.body.data[1]).toEqual({ id: 2, name: 'Cliente B', is_default: false, keys: ['7|fc_live_clienteB'] });
  });
});
