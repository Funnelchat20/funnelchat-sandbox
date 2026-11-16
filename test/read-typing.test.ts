/**
 * Mark as read and «typing…», as conversations v1.19.7 answers them to a key: `204`, or `422` with `error`.
 */
import { describe, expect, it } from 'vitest';
import { startSandbox, OFFICIAL, QR, CONTACT, NO_MESSAGE, NO_DEVICE } from './helpers.js';

describe('mark a message as read', () => {
  it('reads an incoming message: 204, and the conversation is read but for what came after it', async () => {
    const api = await startSandbox();
    const first = await api.call('POST', '/_sandbox/inbound/message', { contact_id: CONTACT, device_id: QR, text: 'Hola' });
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: CONTACT, device_id: QR, text: '¿Siguen ahí?' });
    expect((await api.call('GET', '/api/v1/conversations/count/unread')).body).toEqual({ count: 1 });

    const res = await api.call('POST', `/api/v1/contacts/${CONTACT}/messages/${first.body.message.id}/read`);
    expect(res.status).toBe(204);
    expect((await api.call('GET', `/api/v1/contacts/${CONTACT}`)).body.unread_messages).toBe(1);

    const last = (await api.call('GET', `/api/v1/contacts/${CONTACT}/messages`)).body.data[0];
    await api.call('POST', `/api/v1/contacts/${CONTACT}/messages/${last.id}/read`);
    expect((await api.call('GET', '/api/v1/conversations/count/unread')).body).toEqual({ count: 0 });
  });

  it('refuses a message the contact did not send, and one of another contact', async () => {
    const api = await startSandbox();
    const sent = await api.call('POST', `/api/v1/contacts/${CONTACT}/message`, { device_id: QR, contact_id: CONTACT, text: 'Hola' });
    expect(await api.call('POST', `/api/v1/contacts/${CONTACT}/messages/${sent.body.message.id}/read`)).toMatchObject({
      status: 422,
      body: { error: 'message_not_inbound', message: expect.stringContaining('No se marcó como leído') },
    });
    expect(await api.call('POST', `/api/v1/contacts/${CONTACT}/messages/${NO_MESSAGE}/read`)).toMatchObject({ status: 404, body: { error: 'not_found', message: 'Objeto no encontrado.' } });
  });
});

describe('typing', () => {
  it('only on an official number, over a message the contact sent in the last 24 hours', async () => {
    const api = await startSandbox();
    expect((await api.call('POST', `/api/v1/contacts/${CONTACT}/typing`, {})).body.error).toBe('no_recent_inbound');
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: CONTACT, device_id: QR, text: 'Hola' });
    expect((await api.call('POST', `/api/v1/contacts/${CONTACT}/typing`, {})).body.error).toBe('provider_unsupported');
    expect((await api.call('POST', `/api/v1/contacts/${CONTACT}/typing`, { device_id: OFFICIAL })).body.error).toBe('no_recent_inbound');
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: CONTACT, device_id: OFFICIAL, text: 'Hola' });
    expect((await api.call('POST', `/api/v1/contacts/${CONTACT}/typing`, {})).status).toBe(204);
    expect((await api.call('POST', `/api/v1/contacts/${CONTACT}/typing`, { device_id: NO_DEVICE })).status).toBe(404);
  });
});
