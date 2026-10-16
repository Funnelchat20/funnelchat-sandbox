/**
 * The API key, the routes, the validation against the spec and the send rules, with the errors of the real API.
 */
import { describe, expect, it } from 'vitest';
import { startSandbox } from './helpers.js';

describe('the API key', () => {
  it('answers 401 unauthenticated without a key, like the API', async () => {
    const api = await startSandbox();
    const res = await fetch(`${api.url}/api/v1/contacts`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'unauthenticated', message: 'Falta la API key o no es válida.' });
  });

  it.each(['Bearer fc_live_abc', 'Bearer 1|fc_test_abc', 'Bearer 1|fc_live_', 'Basic 1|fc_live_abc', '1|fc_live_abc'])('rejects a malformed key: %s', async (value) => {
    const api = await startSandbox();
    const res = await api.call('GET', '/api/v1/contacts', undefined, { Authorization: value });
    expect(res.status).toBe(401);
  });

  it('accepts any well-formed key', async () => {
    const api = await startSandbox();
    const res = await api.call('GET', '/api/v1/devices', undefined, { Authorization: 'Bearer 987|fc_live_cualquierCosa123' });
    expect(res.status).toBe(200);
    expect(res.body.map((d: { id: number; provider: number }) => [d.id, d.provider])).toEqual([
      [3, 2],
      [4, 1],
    ]);
  });
});

describe('routes', () => {
  it('a route outside the spec is 404 route_not_found; a known path with another method is 405', async () => {
    const api = await startSandbox();
    expect((await api.call('GET', '/api/v1/nope')).body).toEqual({ error: 'route_not_found', message: 'La ruta no existe en la API.' });
    const res = await api.call('PATCH', '/api/v1/tags');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
  });

  it('a path parameter that does not fit is 404, like a model binding', async () => {
    const api = await startSandbox();
    expect((await api.call('GET', '/api/v1/contacts/abc')).status).toBe(404);
    expect((await api.call('GET', '/api/v1/contacts/999999')).body.error).toBe('not_found');
    expect((await api.call('GET', '/api/v1/webhooks/not-a-uuid')).status).toBe(404);
  });

  it('a route without state answers the example of its response schema', async () => {
    const api = await startSandbox();
    const res = await api.call('GET', '/api/v1/broadcasts');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['data', 'links', 'meta']);
    expect((await api.call('DELETE', '/api/v1/contacts/2001/notes/1')).status).toBe(204);
  });
});

describe('validation against the spec', () => {
  it('answers 422 validation_failed with errors per field and Laravel messages', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { text: 'hola' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: 'validation_failed',
      message: 'El campo device_id es obligatorio. (y 1 error más)',
      errors: { device_id: ['El campo device_id es obligatorio.'], contact_id: ['El campo contact_id es obligatorio.'] },
    });
  });

  it('checks types, lengths and enums, and reads numbers in text like Laravel', async () => {
    const api = await startSandbox();
    const typed = await api.call('POST', '/api/v1/tags', { name: 'x'.repeat(300), color: 5 });
    expect(typed.body.errors).toEqual({
      name: ['El campo name no debe tener más de 254 caracteres.'],
      color: ['El campo color debe ser una cadena de caracteres.'],
    });
    const asText = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: '4', contact_id: '2001', text: 'hola' });
    expect(asText.status).toBe(200);
    expect(asText.body.message.device_id).toBe(4);
    const notNumber = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 'cuatro', contact_id: 2001, text: 'hola' });
    expect(notNumber.body.errors.device_id).toEqual(['El campo device_id debe ser un número entero.']);
  });

  it('validates the query: required, limits and enums', async () => {
    const api = await startSandbox();
    expect((await api.call('GET', '/api/v1/contacts/2001/meta-window')).body.errors).toEqual({ device_id: ['El campo device_id es obligatorio.'] });
    expect((await api.call('GET', '/api/v1/contacts?perPage=500')).body.errors).toEqual({ perPage: ['El campo perPage no debe ser mayor que 100.'] });
    expect((await api.call('GET', '/api/v1/contacts?tag_mode=todos')).body.errors).toEqual({ tag_mode: ['El valor seleccionado en tag_mode no es válido.'] });
    expect((await api.call('GET', '/api/v1/contacts?tag_ids[]=1&tag_mode=any')).status).toBe(200);
  });

  it('a body that is not JSON is 400 invalid_json', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/tags', '{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('a required field sent as null or empty counts as missing', async () => {
    const api = await startSandbox();
    expect((await api.call('POST', '/api/v1/tags', { name: '' })).body.errors).toEqual({ name: ['El campo name es obligatorio.'] });
  });
});

describe('the rules of the real API', () => {
  it('an official number needs the 24-hour window for free text; a QR number does not', async () => {
    const api = await startSandbox();
    const closed = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 3, contact_id: 2001, text: 'hola' });
    expect(closed.status).toBe(422);
    expect(closed.body.error).toBe('window_closed');
    expect((await api.call('GET', '/api/v1/contacts/2001/meta-window?device_id=3')).body).toEqual({ is_open: false, meta_device_id: null });

    expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: 'hola' })).status).toBe(200);

    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 3 });
    expect((await api.call('GET', '/api/v1/contacts/2001/meta-window?device_id=3')).body).toEqual({ is_open: true, meta_device_id: '100000000000003' });
    expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 3, contact_id: 2001, text: 'hola' })).status).toBe(200);

    // An incoming message from 25 hours ago does not open it.
    await api.call('POST', '/_sandbox/window', { contact_id: 2001, device_id: 3, open: false });
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 3, occurred_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 3, contact_id: 2001, text: 'otra' })).body.error).toBe('window_closed');
  });

  it('--no-window turns the window off', async () => {
    const api = await startSandbox({ rules: { window: false } });
    expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 3, contact_id: 2001, text: 'hola' })).status).toBe(200);
  });

  it('recipient_mismatch when phone is not the contact of the route', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, phone: '5491199999999', text: 'hola' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('recipient_mismatch');
    expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, phone: '+54 9 11 0000-0000', text: 'hola' })).status).toBe(200);
  });

  it('recipient_unsupported for a group contact', async () => {
    const api = await startSandbox();
    const group = await api.call('POST', '/api/v1/contacts', { whatsapp_id: '120363000000000001@g.us', name: 'Grupo' });
    const res = await api.call('POST', `/api/v1/contacts/${group.body.id}/message`, { device_id: 4, contact_id: group.body.id, text: 'hola' });
    expect(res.body.error).toBe('recipient_unsupported');
  });

  it('antiblock: a third identical content, and a sixth message without an answer', async () => {
    const api = await startSandbox();
    const send = (text: string) => api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text });
    expect((await send('igual')).status).toBe(200);
    expect((await send('igual')).status).toBe(200);
    expect((await send('igual')).body.error).toBe('antiblock_duplicate_content');
    expect((await send('tres')).status).toBe(200);
    expect((await send('cuatro')).status).toBe(200);
    expect((await send('cinco')).status).toBe(200);
    expect((await send('seis')).body.error).toBe('antiblock_unanswered_limit');
    // The contact answers: the brakes start over.
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 4 });
    expect((await send('seis')).status).toBe(200);
  });

  it('rate_limited with Retry-After after 10 messages per minute to the same contact on an official number', async () => {
    const api = await startSandbox({ rules: { antiblock: false } });
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 3 });
    for (let i = 0; i < 10; i++) {
      expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 3, contact_id: 2001, text: `m${i}` })).status).toBe(200);
    }
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 3, contact_id: 2001, text: 'once' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(50);
    // A QR number has no pace.
    for (let i = 0; i < 12; i++) expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 4, contact_id: 2001, text: `q${i}` })).status).toBe(200);
  });

  it('device_unavailable when the number is disconnected, before the window', async () => {
    const api = await startSandbox();
    await api.call('POST', '/_sandbox/devices/3/disconnect');
    const res = await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 3, contact_id: 2001, text: 'hola' });
    expect(res.body.error).toBe('device_unavailable');
  });

  it('a number outside the account is a validation error on device_id', async () => {
    const api = await startSandbox();
    expect((await api.call('POST', '/api/v1/contacts/2001/message', { device_id: 99, contact_id: 2001, text: 'hola' })).body.errors).toEqual({
      device_id: ['El valor seleccionado en device_id no es válido.'],
    });
  });

  it('a template with a missing variable is 422 template_unresolved_placeholder', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/devices/3/templates/45/send-template', { phone: '5491100000000', contact_id: 2001 });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'template_unresolved_placeholder', placeholders: ['{{1}}'] });
  });
});
