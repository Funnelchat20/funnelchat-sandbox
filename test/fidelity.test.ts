/**
 * What the sandbox used to accept and production refuses, or answered in another shape (DX study of 17-11, section 3.3):
 * each case as conversations and accounts answer it on origin/main.
 */
import { describe, expect, it } from 'vitest';
import { startReceiver, startSandbox, subscribe, until, CONTACT, MESSAGE_ID, OFFICIAL, QR, TAG, NO_DEVICE } from './helpers.js';

const PARAMS = { body: { '1': '{name}' }, samples: { body: { '1': 'Lucía' } } };
const TEMPLATE = { device_id: OFFICIAL, name: 'aviso_pedido_listo', language_code: 'es', category: 'UTILITY', type: 'text', body: 'Hola {{1}}, tu pedido ya está listo.' };

describe('creating a template: the rules of conversations', () => {
  it('a {{1}} without params is a 422 on body, with both messages, and nothing is created', async () => {
    const api = await startSandbox();
    const before = (await api.call('GET', '/api/v1/templates')).body.data.length;
    const res = await api.call('POST', '/api/v1/templates', TEMPLATE);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'validation_failed',
      errors: { body: ['Falta elegir el campo de {{1}}.', 'Falta el valor de ejemplo de {{1}}. Meta lo usa para revisar la plantilla.'] },
    });
    expect((await api.call('GET', '/api/v1/templates')).body.data.length).toBe(before);
  });

  it('a list of texts (the old shape) only declares fields: the sample is missing', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, params: ['Lucía'] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ body: ['Falta el valor de ejemplo de {{1}}. Meta lo usa para revisar la plantilla.'] });
  });

  it('device_id is required, and must be a number of the account', async () => {
    const api = await startSandbox();
    const withoutDevice: Record<string, unknown> = { ...TEMPLATE, params: PARAMS };
    delete withoutDevice.device_id;
    const missing = await api.call('POST', '/api/v1/templates', withoutDevice);
    expect(missing.status).toBe(422);
    expect(missing.body.errors).toEqual({ device_id: ['El campo device id es requerido.'] });
    const foreign = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, device_id: NO_DEVICE, params: PARAMS });
    expect(foreign.status).toBe(422);
    expect(foreign.body).toEqual({ error: 'validation_failed', message: 'Device not found', error_code: 'device_not_found' });
  });

  it('a template that is not text needs file', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, type: 'image', params: PARAMS });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ file: ['El campo file es requerido a menos que type esté en text.'] });
  });

  it('with a field and a sample per variable: 201, PENDING, params in the canonical shape', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, params: PARAMS });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING', device_id: OFFICIAL, params: PARAMS });
    const plain = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, name: 'sin_variables', body: 'Tu pedido ya está listo.' });
    expect(plain.status).toBe(201);
    expect(plain.body.params).toEqual({ body: [], samples: { body: [] } });
  });

  it('on a QR number it is created and then REJECTED, without an event, as the job of conversations leaves it', async () => {
    const api = await startSandbox({ templateApprovalSeconds: 0.05 });
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['template.status_changed']);
    const res = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, device_id: QR, params: PARAMS });
    expect(res.status).toBe(201);
    await until(() => api.sandbox.app.store.templates.get(res.body.id)?.status === 'REJECTED');
    expect((await api.call('GET', `/api/v1/templates/${res.body.id}`)).body).toMatchObject({ status: 'REJECTED', observation: 'El dispositivo no tiene WABA ID configurado.' });
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.received).toHaveLength(0);
  });

  it('editing it follows the same rules', async () => {
    const api = await startSandbox();
    const created = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, params: PARAMS });
    const edit: Record<string, unknown> = { ...TEMPLATE, body: 'Hola {{1}}, tu pedido {{2}} está listo.', params: PARAMS };
    delete edit.name;
    delete edit.language_code;
    const res = await api.call('PUT', `/api/v1/templates/${created.body.id}`, edit);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ body: ['Falta elegir el campo de {{2}}.', 'Falta el valor de ejemplo de {{2}}. Meta lo usa para revisar la plantilla.'] });
  });

  it('a rejection by Meta announces reason null; the reason stays in the observation', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['template.status_changed']);
    const created = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, params: PARAMS });
    await api.call('POST', `/_sandbox/templates/${created.body.id}/status`, { status: 'REJECTED', reason: 'INVALID_FORMAT' });
    const [d] = await receiver.waitFor(1);
    expect(d!.json.data).toMatchObject({ previous_status: 'PENDING', status: 'REJECTED', reason: null });
    expect((await api.call('GET', `/api/v1/templates/${created.body.id}`)).body.observation).toBe('INVALID_FORMAT');
  });
});

describe('booleans of a query: 1 or 0', () => {
  it('activeConversation=true is a 422, like Laravel\'s boolean rule; 1 and 0 filter', async () => {
    const api = await startSandbox();
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: CONTACT, device_id: QR, text: 'Hola' });
    const refused = await api.call('GET', '/api/v1/conversations?activeConversation=true');
    expect(refused.status).toBe(422);
    expect(Object.keys(refused.body.errors)).toEqual(['activeConversation']);
    expect((await api.call('GET', '/api/v1/conversations?activeConversation=1')).body.data).toHaveLength(1);
    expect((await api.call('GET', '/api/v1/conversations?activeConversation=0')).body.data).toHaveLength(0);
  });

  it('?bulk=true of add-tags is read with $request->boolean(): it is accepted', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/contacts/add-tags?bulk=true', [{ contactId: CONTACT, tag: { id: TAG } }]);
    expect(res.status).toBe(200);
  });
});

describe('pagination links copy the query as it came', () => {
  /** Follows `links.next` from `path` to the last page: every page answers 200 and every link keeps `keep`. */
  async function follow(api: Awaited<ReturnType<typeof startSandbox>>, path: string, keep: string[]): Promise<number> {
    let url: string | null = `${api.url}${path}`;
    let pages = 0;
    while (url) {
      const res = await api.call('GET', url.slice(api.url.length));
      expect(res.status, url).toBe(200);
      pages += 1;
      for (const link of [res.body.links.next, res.body.links.prev, res.body.links.first, res.body.links.last]) {
        if (typeof link !== 'string') continue;
        for (const pair of keep) expect(link, link).toContain(pair);
        expect(link).not.toMatch(/=(true|false)(&|$)/);
      }
      url = res.body.links.next;
      expect(pages).toBeLessThan(20);
    }
    return pages;
  }

  it('activeConversation=1 stays 1 in links.next of /conversations, and the next page answers', async () => {
    const api = await startSandbox();
    for (const phone of ['5491155550101', '5491155550102', '5491155550103']) {
      const contact = await api.call('POST', '/api/v1/contacts', { phone, name: `Contacto ${phone.slice(-3)}` });
      await api.call('POST', '/_sandbox/inbound/message', { contact_id: contact.body.id, device_id: QR, text: 'Hola' });
    }
    expect(await follow(api, '/api/v1/conversations?activeConversation=1&perPage=1', ['activeConversation=1'])).toBe(3);
  });

  it('withContactCount=1 stays 1 in links.next, prev and last of /tags and /custom-fields', async () => {
    const api = await startSandbox();
    for (const name of ['Paginado uno', 'Paginado dos']) {
      expect((await api.call('POST', '/api/v1/tags', { name })).status).toBeLessThan(300);
      expect((await api.call('POST', '/api/v1/custom-fields', { name, type: 0 })).status).toBeLessThan(300);
    }
    expect(await follow(api, '/api/v1/tags?withContactCount=1&perPage=1', ['withContactCount=1'])).toBeGreaterThan(2);
    expect(await follow(api, '/api/v1/custom-fields?withContactCount=1&perPage=1', ['withContactCount=1'])).toBeGreaterThan(1);
  });
});

describe('GET /api/v1/conversations: the row of the listing, not a contact', () => {
  it('the contact is contact_id, id is its last message, and the page has links and meta.total', async () => {
    const api = await startSandbox();
    const inbound = await api.call('POST', '/_sandbox/inbound/message', { contact_id: CONTACT, device_id: OFFICIAL, text: 'Hola' });
    const res = await api.call('GET', '/api/v1/conversations?perPage=10');
    expect(res.status).toBe(200);
    const [row] = res.body.data;
    expect(row).toMatchObject({
      contact_id: CONTACT,
      contact_name: 'Contacto de ejemplo',
      contact_phone: '5491100000000',
      contact_active_conversation: 1,
      unread_messages: 1,
      tag_ids: [],
      manually_unread: false,
      is_mac_inactive: false,
      id: inbound.body.message.id,
      own: 0,
      text: 'Hola',
      type: 0,
      device_id: OFFICIAL,
      last_device_id: OFFICIAL,
      meta_window_inbounds: [{ device_id: OFFICIAL, last_inbound_at: expect.stringMatching(/\+00:00$/) }],
    });
    expect(row.id).toMatch(MESSAGE_ID);
    expect(row).not.toHaveProperty('last_message');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(res.body.links.first).toBe(`${api.url}/api/v1/conversations?perPage=10`);
    expect(res.body.meta).toMatchObject({ per_page: 10, next_cursor: null, prev_cursor: null, total: 1 });
  });
});

describe('contacts: 201 when created, and custom_fields kept', () => {
  it('update-or-create answers 201 when it creates and 200 when it updates', async () => {
    const api = await startSandbox();
    const created = await api.call('POST', '/api/v1/contacts/update-or-create', { phone: '5491155550001', name: 'Ana' });
    expect(created.status).toBe(201);
    const updated = await api.call('POST', '/api/v1/contacts/update-or-create', { phone: '5491155550001', name: 'Ana María' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id: created.body.id, name: 'Ana María' });
  });

  it('custom_fields are written, on a new contact and on an existing one', async () => {
    const api = await startSandbox();
    const field = (await api.call('POST', '/api/v1/custom-fields', { name: 'Segmento', type: 0 })).body;
    const amount = (await api.call('POST', '/api/v1/custom-fields', { name: 'Monto', type: 1 })).body;
    const created = await api.call('POST', '/api/v1/contacts/update-or-create', { phone: '5491155550002', custom_fields: [{ id: field.id, value: 'Mayorista' }] });
    expect(created.status).toBe(201);
    expect(created.body.custom_fields).toMatchObject([{ id: field.id, value: 'Mayorista' }]);
    await api.call('POST', '/api/v1/contacts/update-or-create', { phone: '5491155550002', custom_fields: [{ id: amount.id, value: '1500.50' }] });
    const values = (await api.call('GET', `/api/v1/contacts/${created.body.id}/custom-fields`)).body.data;
    expect(values.map((v: { id: string; value: string }) => [v.id, v.value])).toEqual([
      [field.id, 'Mayorista'],
      [amount.id, '1500.50'],
    ]);
    const store = await api.call('POST', '/api/v1/contacts', { phone: '5491155550003', custom_fields: [{ id: field.id, value: 'Minorista' }] });
    expect(store.status).toBe(201);
    expect(store.body.custom_fields).toMatchObject([{ id: field.id, value: 'Minorista' }]);
  });

  it('a field that is not of the account, or a value out of its format, is a 422 and nothing is created', async () => {
    const api = await startSandbox();
    const amount = (await api.call('POST', '/api/v1/custom-fields', { name: 'Monto', type: 1 })).body;
    const foreign = await api.call('POST', '/api/v1/contacts/update-or-create', { phone: '5491155550004', custom_fields: [{ id: 'fld_Ejemplo0000000000000000', value: 'x' }] });
    expect(foreign.status).toBe(422);
    expect(foreign.body.errors).toEqual({ 'custom_fields.0.id': ['El custom_fields.0.id seleccionado no es válido.'] });
    const format = await api.call('POST', '/api/v1/contacts/update-or-create', { phone: '5491155550004', custom_fields: [{ id: amount.id, value: '1,500' }] });
    expect(format.status).toBe(422);
    expect(format.body.errors['custom_fields.0.value'][0]).toContain('«Monto» es numérico');
    expect((await api.call('GET', '/api/v1/contacts?phone=5491155550004')).body.data).toEqual([]);
  });
});

describe('add-tags and remove-tags keep the tags', () => {
  it('200 without a body, the tag stays and contact.tag_added goes out; remove-tags takes it off', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['contact.tag_added', 'contact.tag_removed']);
    const added = await api.call('POST', '/api/v1/contacts/add-tags', [{ contactId: CONTACT, tag: { id: TAG } }]);
    expect(added.status).toBe(200);
    expect(added.body).toBeNull();
    expect(added.headers.get('x-sandbox-simulated')).toBeNull();
    expect((await api.call('GET', `/api/v1/contacts/${CONTACT}/tags`)).body.data.map((t: { id: string }) => t.id)).toEqual([TAG]);
    // Again: nothing changes and nothing goes out.
    await api.call('POST', '/api/v1/contacts/add-tags', [{ contactId: CONTACT, tag: { id: TAG } }]);
    const removed = await api.call('POST', '/api/v1/contacts/remove-tags', [{ contactId: CONTACT, tag: { id: TAG } }]);
    expect(removed.status).toBe(200);
    expect((await api.call('GET', `/api/v1/contacts/${CONTACT}/tags`)).body.data).toEqual([]);
    const [on, off] = await receiver.waitFor(2);
    expect(on!.json).toMatchObject({ type: 'contact.tag_added', data: { contact: { id: CONTACT }, tag: { id: TAG, name: 'Cliente' }, source: 'manual' } });
    expect(off!.json).toMatchObject({ type: 'contact.tag_removed', data: { tag: { id: TAG }, source: 'manual' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(receiver.received).toHaveLength(2);
  });

  it('an item whose contact or tag does not exist is skipped, without an error', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', '/api/v1/contacts/add-tags', [{ contactId: 'ctc_Ejemplo0000000000000000', tag: { id: TAG } }]);
    expect(res.status).toBe(200);
  });
});

describe('device.disconnected: the reasons of accounts', () => {
  it('provider_error is not a reason any more', async () => {
    const api = await startSandbox();
    const res = await api.call('POST', `/_sandbox/devices/${QR}/disconnect`, { reason: 'provider_error' });
    expect(res.status).toBe(422);
    expect(res.body.errors.reason[0]).toBe('reason must be one of: qr_logged_out, meta_account_not_registered, shadow_ban_protection, disconnected_by_user, unknown.');
  });
});

describe('the tap of a button', () => {
  it('a question with options: message.received interactive, with the label in text', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['message.received']);
    const sent = await api.call('POST', '/api/v1/message/send-message', {
      contact_id: CONTACT,
      device_id: QR,
      text: '¿Con quién quieres hablar?',
      options: [
        { id: 'ventas', label: 'Ventas' },
        { id: 'humano', label: 'Una persona del equipo de soporte' },
      ],
    });
    expect(sent.status).toBe(200);
    const tap = await api.call('POST', '/_sandbox/inbound', { reply: { to_message_id: sent.body.message.id, option_id: 'humano' } });
    expect(tap.status).toBe(201);
    const [d] = await receiver.waitFor(1);
    // Buttons (1 to 3) cut the label at 20 characters, like WhatsApp shows it.
    expect(d!.json.data).toMatchObject({ message: { type: 'interactive', text: 'Una persona del equi', media: null }, contact: { id: CONTACT }, device_id: QR });
    const bad = await api.call('POST', '/_sandbox/inbound', { reply: { to_message_id: sent.body.message.id, option_id: 'otra' } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors['reply.option_id'][0]).toContain('ventas, humano');
  });

  it('a quick-reply button of a template: template_button_reply', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['message.received']);
    const template = await api.call('POST', '/api/v1/templates', { ...TEMPLATE, params: PARAMS, buttons: [{ type: 'QUICK_REPLY', text: 'Lo retiro hoy' }] });
    await api.call('POST', `/_sandbox/templates/${template.body.id}/status`, { status: 'APPROVED' });
    const sent = await api.call('POST', `/api/v1/devices/${OFFICIAL}/templates/${template.body.id}/send-template`, { contact_id: CONTACT, phone: '5491100000000', template_variables: { body: ['Lucía'] } });
    expect(sent.status).toBe(200);
    await api.call('POST', '/_sandbox/inbound/message', { reply: { to_message_id: sent.body.message.id, option_id: 'Lo retiro hoy' } });
    const [d] = await receiver.waitFor(1);
    expect(d!.json.data.message).toMatchObject({ type: 'template_button_reply', text: 'Lo retiro hoy' });
  });

  it('a message without choices cannot be tapped', async () => {
    const api = await startSandbox();
    const sent = await api.call('POST', '/api/v1/message/send-message', { contact_id: CONTACT, device_id: QR, text: 'Hola' });
    const tap = await api.call('POST', '/_sandbox/inbound', { reply: { to_message_id: sent.body.message.id, option_id: 'x' } });
    expect(tap.status).toBe(422);
    expect(Object.keys(tap.body.errors)).toEqual(['reply.to_message_id']);
  });
});
