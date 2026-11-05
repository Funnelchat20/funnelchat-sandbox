/**
 * Mark as read and «typing…», as conversations v1.19.7 answers them to a key: `204`, or `422` with `error`.
 */
import { describe, expect, it } from 'vitest';
import { startSandbox } from './helpers.js';

describe('mark a message as read', () => {
  it('reads an incoming message: 204, and the conversation is read but for what came after it', async () => {
    const api = await startSandbox();
    const first = await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 4, text: 'Hola' });
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 4, text: '¿Siguen ahí?' });
    expect((await api.call('GET', '/api/v1/conversations/count/unread')).body).toEqual({ count: 1 });

    const res = await api.call('POST', `/api/v1/contacts/2001/messages/${first.body.message.id}/read`);
    expect(res.status).toBe(204);
    expect((await api.call('GET', '/api/v1/contacts/2001')).body.unread_messages).toBe(1);

    const last = (await api.call('GET', '/api/v1/contacts/2001/messages')).body.data[0];
    await api.call('POST', `/api/v1/contacts/2001/messages/${last.id}/read`);
    expect((await api.call('GET', '/api/v1/conversations/count/unread')).body).toEqual({ count: 0 });
  });

  it('refuses a message the contact did not send, and one of another contact', async () => {
    const api = await startSandbox();
    const sent = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'Hola' });
    expect(await api.call('POST', `/api/v1/contacts/2001/messages/${sent.body.message.id}/read`)).toMatchObject({
      status: 422,
      body: { error: 'message_not_inbound', message: expect.stringContaining('No se marcó como leído') },
    });
    expect(await api.call('POST', '/api/v1/contacts/2001/messages/99999/read')).toMatchObject({ status: 404, body: { message: 'Objeto no encontrado.' } });
  });
});

describe('typing', () => {
  it('only on an official number, over a message the contact sent in the last 24 hours', async () => {
    const api = await startSandbox();
    expect((await api.call('POST', '/api/v1/contacts/2001/typing', {})).body.error).toBe('no_recent_inbound');
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 4, text: 'Hola' });
    expect((await api.call('POST', '/api/v1/contacts/2001/typing', {})).body.error).toBe('provider_unsupported');
    expect((await api.call('POST', '/api/v1/contacts/2001/typing', { device_id: 3 })).body.error).toBe('no_recent_inbound');
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 3, text: 'Hola' });
    expect((await api.call('POST', '/api/v1/contacts/2001/typing', {})).status).toBe(204);
    expect((await api.call('POST', '/api/v1/contacts/2001/typing', { device_id: 99 })).status).toBe(404);
  });
});
