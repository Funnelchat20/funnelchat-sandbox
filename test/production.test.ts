/**
 * What production answers since 21-10 (accounts v1.4.24, conversations v1.18.10, communities v2.34.52, api-edge
 * v0.3.0): X-Request-Id, the edge's errors, the file by URL, the MAC, the bodies of each route, the numbers'
 * capabilities and the polls and events the gate closes.
 */
import { describe, expect, it } from 'vitest';
import { startReceiver, startSandbox, subscribe } from './helpers.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('X-Request-Id', () => {
  it('is a fresh UUID v4 on every answer, errors included, only in the header; one the client sends is ignored', async () => {
    const api = await startSandbox();
    const answers = [
      await api.call('GET', '/api/v1/devices', undefined, { 'X-Request-Id': '3f2b8c1e-9a4d-4e7b-8c21-5d6f0a9b1c3e' }),
      await api.call('GET', '/api/v1/contacts', undefined, { Authorization: 'Bearer nope' }),
      await api.call('GET', '/api/v1/nope'),
      await api.call('GET', '/_sandbox/state'),
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 401, 404, 200]);
    const ids = answers.map((a) => a.headers.get('x-request-id'));
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).not.toBe('3f2b8c1e-9a4d-4e7b-8c21-5d6f0a9b1c3e');
    expect(answers[1]!.body).toEqual({ error: 'unauthenticated', message: 'Falta la API key o no es válida.' });
    const logged = (await api.call('GET', '/_sandbox/requests')).body.data;
    expect(logged.map((r: { requestId: string }) => r.requestId)).toEqual(expect.arrayContaining([ids[0]]));
  });
});

describe('errors of the edge', () => {
  it('X-Sandbox-Edge: origin_unreachable never reaches the domain; _applied does, and loses the answer', async () => {
    const api = await startSandbox();
    const before = (await api.call('GET', '/api/v1/contacts')).body.meta.total;
    const lost = await api.call('POST', '/api/v1/contacts', { phone: '5491100000077', name: 'Uno' }, { 'X-Sandbox-Edge': 'origin_unreachable' });
    expect(lost.status).toBe(502);
    expect(lost.body).toEqual({ error: 'origin_unreachable', message: 'La API no está disponible en este momento.' });
    expect(lost.headers.get('retry-after')).toBeNull();
    expect((await api.call('GET', '/api/v1/contacts')).body.meta.total).toBe(before);

    const applied = await api.call('POST', '/api/v1/contacts', { phone: '5491100000078', name: 'Dos' }, { 'X-Sandbox-Edge': 'origin_unreachable_applied' });
    expect(applied.status).toBe(502);
    // The write happened: read the state before repeating it.
    expect((await api.call('GET', '/api/v1/contacts')).body.meta.total).toBe(before + 1);

    const misconfigured = await api.call('GET', '/api/v1/devices', undefined, { 'X-Sandbox-Edge': 'edge_misconfigured' });
    expect(misconfigured.status).toBe(500);
    expect(misconfigured.body.error).toBe('edge_misconfigured');
  });

  it('can be armed for the next calls, for clients that cannot send headers', async () => {
    const api = await startSandbox();
    expect((await api.call('POST', '/_sandbox/failures', { mode: 'edge', code: 'origin_unreachable', count: 2 })).status).toBe(201);
    expect((await api.call('GET', '/api/v1/devices')).status).toBe(502);
    expect((await api.call('GET', '/api/v1/devices')).status).toBe(502);
    expect((await api.call('GET', '/api/v1/devices')).status).toBe(200);
    expect((await api.call('POST', '/_sandbox/failures', { mode: 'edge', code: 'nope' })).status).toBe(422);
  });
});

describe('the file of a send', () => {
  const send = (api: Awaited<ReturnType<typeof startSandbox>>, extra: Record<string, unknown>, path = '/api/v1/contacts/2001/message') =>
    api.call('POST', path, { device_id: 4, contact_id: 2001, ...extra });

  it('infers the type from the extension like conversations', async () => {
    const api = await startSandbox({ rules: { antiblock: false } });
    const types = [];
    for (const file of ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/a.webp', 'https://cdn.example.com/a.gif', 'https://cdn.example.com/a.ogg', 'https://s3.example.com/obj?X-Amz-Signature=abc&name=factura.pdf']) {
      const res = await send(api, { file });
      expect(res.status).toBe(200);
      types.push(res.body.message.type);
    }
    expect(types).toEqual(['image', 'sticker', 'video', 'audio', 'document']);
  });

  it('a URL that does not say its format needs file_type; an explicit file_type wins', async () => {
    const api = await startSandbox();
    const res = await send(api, { file: 'https://cdn.example.com/descarga/8841' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({
      file_type: ['Tu archivo viene de una URL que no indica su formato: envía file_type con uno de estos valores: image, video, audio, document o sticker.'],
    });
    const typed = await send(api, { file: 'https://cdn.example.com/descarga/8841', file_type: 'video' });
    expect(typed.body.message.type).toBe('video');
    expect((await send(api, { file: 'https://cdn.example.com/a.jpg', file_type: 'gif' })).body.errors.file_type).toBeDefined();
  });

  it('a document without a supported extension needs file_name with one', async () => {
    const api = await startSandbox();
    const res = await send(api, { file: 'https://cdn.example.com/descarga/8841', file_type: 'document' });
    expect(res.status).toBe(422);
    expect(res.body.errors.file_name[0]).toContain('factura.pdf');
    expect((await send(api, { file: 'https://cdn.example.com/descarga/8841', file_type: 'document', file_name: 'factura.pdf' })).body.message.type).toBe('document');
    expect((await send(api, { file: 'https://cdn.example.com/a.pdf', file_type: 'document', file_name: 'mal/nombre.pdf' })).body.errors.file_name).toBeDefined();
  });

  it('a known but unsupported extension is 415, with the body of each route', async () => {
    const api = await startSandbox();
    const conversation = await send(api, { file: 'https://cdn.example.com/a.zip' });
    expect(conversation.status).toBe(415);
    expect(conversation.body).toEqual({ error: 'Unsupported file type: zip', supported_file_types: expect.arrayContaining(['jpg', 'pdf', 'webp']) });
    const direct = await send(api, { file: 'https://cdn.example.com/a.zip' }, '/api/v1/message/send-message');
    expect(direct.status).toBe(415);
    expect(direct.body).toEqual({ status: 'error', error: 'Unsupported file type: zip' });
  });

  it('client_reference is 1 to 64 visible ASCII characters', async () => {
    const api = await startSandbox();
    expect((await send(api, { text: 'x', client_reference: 'con espacio' })).body.errors).toEqual({ client_reference: ['El formato del campo client_reference no es válido.'] });
    expect((await send(api, { text: 'x', client_reference: 'x'.repeat(65) })).status).toBe(422);
    expect((await send(api, { text: 'x', client_reference: 'pedido-8841' })).body.message.client_reference).toBe('pedido-8841');
  });
});

describe('the MAC of the account', () => {
  it('in lockout, a send to a contact that is not active answers 429 mac_lockout_24h; templates have no MAC gate', async () => {
    const api = await startSandbox();
    const other = (await api.call('POST', '/api/v1/contacts', { phone: '5491100000088', name: 'Activo' })).body.id;
    await api.call('POST', '/_sandbox/mac', { lockout: true, active_contact_ids: [other] });
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'Hola' });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'mac_lockout_24h', message: 'Tu cuenta está en bloqueo de 24h por agotamiento de MACs.' });
    expect(res.headers.get('retry-after')).toBeNull();
    expect((await api.call('POST', `/api/v1/contacts/${other}/message`, { device_id: 4, contact_id: other, text: 'Hola' })).status).toBe(200);
    const template = await api.call('POST', '/api/v1/devices/3/templates/45/send-template', { phone: '5491100000000', contact_id: 2001, template_variables: { body: ['Lucía'] } });
    expect(template.status).toBe(200);

    // The forward is not a 429: that destination comes back blocked.
    const source = (await api.call('POST', `/api/v1/contacts/${other}/message`, { device_id: 4, contact_id: other, text: 'Reenvíame' })).body.message.id;
    const forward = await api.call('POST', `/api/v1/contacts/${other}/messages/${source}/forward`, { targets: [{ contact_id: 2001, device_id: 4 }, { contact_id: other, device_id: 4 }] });
    expect(forward.status).toBe(200);
    expect(forward.body[0]).toEqual({ contact_id: 2001, mode: 'native', status: 'blocked', reason: 'mac_lockout_24h', message: null });
    expect(forward.body[1]).toMatchObject({ contact_id: other, status: 'queued', reason: null });
  });

  it('a contact inactive by MAC gets the same answer without a lockout', async () => {
    const api = await startSandbox();
    await api.call('POST', '/_sandbox/mac', { inactive_contact_ids: [2001] });
    expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'Hola' })).body.error).toBe('mac_lockout_24h');
    expect((await api.call('GET', '/_sandbox/mac')).body).toEqual({ lockout: false, active_contact_ids: [], inactive_contact_ids: [2001] });
  });
});

describe('the bodies of each route', () => {
  it('send-message, send-template and the lookup answer their own shapes', async () => {
    const api = await startSandbox();
    expect(await api.call('POST', '/api/v1/message/send-message', { device_id: 4, contact_id: 999999, text: 'x' })).toMatchObject({ status: 404, body: { status: 'error', error: 'Contacto no encontrado.' } });
    expect(await api.call('POST', '/api/v1/message/send-message', { device_id: 99, contact_id: 2001, text: 'x' })).toMatchObject({ status: 403, body: { status: 'error', error: 'No autorizado' } });
    expect(await api.call('POST', '/api/v1/devices/3/templates/999/send-template', { phone: '5491100000000', contact_id: 2001 })).toMatchObject({ status: 404, body: { error: 'template_not_found' } });
    expect(await api.call('POST', '/api/v1/devices/4/templates/45/send-template', { phone: '5491100000000', contact_id: 2001 })).toMatchObject({
      status: 422,
      body: { error: 'La plantilla no pertenece al número actual', error_code: 'template_waba_mismatch' },
    });
    const missing = await api.call('POST', '/api/v1/devices/3/templates/45/send-template', { phone: '5491100000000', contact_id: 2001, template_variables: { body: [] } });
    expect(missing.body).toMatchObject({ error: 'template_unresolved_placeholder', placeholders: ['{{1}}'], count: 1 });
    expect(await api.call('GET', '/api/v1/contacts/2001/messages/424242')).toMatchObject({ status: 404, body: { message: 'Objeto no encontrado.' } });
    expect(await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, note: true, text: 'n', options: [{ id: 'a', label: 'A' }] })).toMatchObject({
      status: 422,
      body: { error: 'A note cannot carry interactive options.' },
    });
  });

  it('a forced failure carries the titles of production', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['message.status_changed']);
    await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'x' }, { 'X-Sandbox-Fail': 'insufficient_balance' });
    const [event] = await receiver.waitFor(1);
    expect(event!.json.data.error).toEqual({ code: null, title: 'Saldo insuficiente en tu billetera de WhatsApp.', reason: 'insufficient_balance' });
  });
});

describe('numbers and groups', () => {
  it('GET /devices always paginates and each number carries its capabilities', async () => {
    const api = await startSandbox();
    const res = await api.call('GET', '/api/v1/devices');
    expect(Object.keys(res.body)).toEqual(['data', 'links', 'meta']);
    const [cloud, qr] = res.body.data;
    expect(Object.keys(cloud).slice(-11)).toEqual(['health', 'number_key', 'number_key_confirmed', 'is_coexistence', 'slot_state', 'pool_suspended', 'pool_suspension_reason', 'pool_keep', 'qr_allowed', 'can_change_to_meta', 'capabilities']);
    expect(cloud.capabilities.messages).toMatchObject({ templates: true, polls: false, reactions: false });
    expect(cloud.capabilities.groups.create).toBe(false);
    expect(cloud.health).toMatchObject({ state: 'available' });
    expect(qr.health).toBeNull();
    expect(qr.capabilities).toMatchObject({ messages: { templates: false, polls: true }, groups: { create: true, add_participants: 'direct', join_requests: false }, statuses: ['sent', 'delivered', 'read', 'failed'] });
    expect(await api.call('GET', '/api/v1/devices/99')).toMatchObject({ status: 404, body: { message: 'Object not found' } });
  });

  it('polls and events answer 403 route_not_available', async () => {
    const api = await startSandbox();
    for (const path of ['/api/v1/contacts/2001/message/poll', '/api/v1/contacts/2001/message/event']) {
      const res = await api.call('POST', path, {});
      expect(res.status, path).toBe(403);
      expect(res.body.error).toBe('route_not_available');
    }
  });

  it('group.message_received is emitted with the shape of communities', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['group.message_received']);
    await api.call('POST', '/_sandbox/events/group.message_received', { data: { message: { text: '¿A qué hora?' } } });
    const [d] = await receiver.waitFor(1);
    expect(d!.json.data.message).toEqual({ uid: 'msg-ejemplo-01', type: 'text', text: '¿A qué hora?', caption: null, media_url: null, mime_type: null, file_name: null, quoted_uid: null });
  });
});
