/**
 * WhatsApp forms, as conversations v1.18.10: build, publish, send to a contact, complete (whatsapp_form.completed)
 * and read the answers.
 */
import { describe, expect, it } from 'vitest';
import { startReceiver, startSandbox, subscribe, OFFICIAL, QR, CONTACT, NO_FORM_FAMILY } from './helpers.js';

describe('WhatsApp forms', () => {
  it('lists the five templates and only takes official numbers', async () => {
    const api = await startSandbox();
    const templates = await api.call('GET', '/api/v1/forms/templates');
    expect(templates.body.data.map((t: { key: string }) => t.key)).toEqual(['blank', 'lead', 'appointment', 'nps', 'signup']);
    expect(Object.keys(templates.body.data[0])).toEqual(['key', 'title', 'description', 'category']);
    const qr = await api.call('POST', '/api/v1/forms', { device_id: QR, template_key: 'lead' });
    expect(qr).toMatchObject({ status: 422, body: { error: 'NUMBER_NOT_ELIGIBLE', message: 'Disponible para números conectados con la API de WhatsApp' } });
    expect((await api.call('POST', '/api/v1/forms', { device_id: OFFICIAL, template_key: 'nope' })).body.errors.template_key).toBeDefined();
  });

  it('a blank form does not publish: LINT no_data', async () => {
    const api = await startSandbox();
    const created = await api.call('POST', '/api/v1/forms', { device_id: OFFICIAL, template_key: 'blank' });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body)).toEqual(['data', 'lint', 'numbers']);
    expect(created.body.data).toMatchObject({ name: 'blank', label: 'blank', status: 'draft', version: 1, lint_errors_count: 1, meta_flow_id: null, published_at: null });
    expect(created.body.lint).toEqual([{ code: 'no_data', severity: 'error', screenId: null, itemId: null, message: 'El formulario no recoge ningún dato' }]);
    expect(created.body.numbers).toEqual([{ device_id: OFFICIAL, primary: true, status: 'draft', error: null }]);
    const publish = await api.call('POST', `/api/v1/forms/${created.body.data.id}/publish`);
    expect(publish).toMatchObject({ status: 422, body: { error: 'LINT', message: 'Corrige los pendientes antes de continuar' } });
  });

  it('build → publish → send → complete → whatsapp_form.completed and the responses', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['whatsapp_form.completed']);

    const created = (await api.call('POST', '/api/v1/forms', { device_id: OFFICIAL, template_key: 'lead' })).body.data;
    expect(created.fields.map((f: { name: string }) => f.name)).toEqual(['nombre', 'email', 'rubro', 'volumen']);
    expect(created.mapping).toEqual({ nombre: { target: 'name', key: null, policy: 'if_empty' }, email: { target: 'email', key: null, policy: 'if_empty' } });

    // Not published yet.
    await api.call('POST', '/_sandbox/inbound/message', { contact_id: CONTACT, device_id: OFFICIAL });
    const early = await api.call('POST', `/api/v1/contacts/${CONTACT}/message/form`, { form_id: created.family_id, device_id: OFFICIAL });
    expect(early.body.error).toBe('form_not_published');

    const published = await api.call('POST', `/api/v1/forms/${created.id}/publish`);
    expect(published.body.data).toMatchObject({ status: 'published', version: 1 });
    expect(published.body.data.meta_flow_id).toEqual(expect.any(String));
    // A valid body (the spec requires definition.screens): an invalid one is a 422 before the form is looked at.
    expect((await api.call('PUT', `/api/v1/forms/${created.id}`, { definition: { screens: [] } })).body.error).toBe('PUBLISHED');

    // The rules of a form send.
    expect((await api.call('POST', `/api/v1/contacts/${CONTACT}/message/form`, { form_id: NO_FORM_FAMILY, device_id: OFFICIAL })).status).toBe(404);
    // `form_id` is the family (`frm_`); the id of a version (`frv_`) is not one.
    expect((await api.call('POST', `/api/v1/contacts/${CONTACT}/message/form`, { form_id: created.id, device_id: OFFICIAL })).body.errors).toHaveProperty('form_id');
    expect((await api.call('POST', `/api/v1/contacts/${CONTACT}/message/form`, { form_id: created.family_id, device_id: QR })).body.error).toBe('number_not_eligible');

    const sent = await api.call('POST', `/api/v1/contacts/${CONTACT}/message/form`, { form_id: created.family_id, device_id: OFFICIAL, client_reference: 'pedido-42' });
    expect(sent.status).toBe(200);
    expect(sent.body.message).toMatchObject({ type: 'whatsapp_form', status: 'queued', client_reference: 'pedido-42', direction: 'outbound' });
    expect((await api.call('GET', `/api/v1/contacts/${CONTACT}/messages/${sent.body.message.id}`)).body.type).toBe('whatsapp_form');

    const done = await api.call('POST', '/_sandbox/forms/complete', { message_id: sent.body.message.id, answers: { nombre: 'Ana', volumen: 'op_mas_de_quinientos' } });
    expect(done.status).toBe(200);
    const [event] = await receiver.waitFor(1);
    expect(event!.json.type).toBe('whatsapp_form.completed');
    expect(Object.keys(event!.json.data)).toEqual(['form', 'message_id', 'contact_id', 'device_id', 'answers', 'occurred_at', 'workspace_id']);
    expect(event!.json.data).toMatchObject({
      form: { id: created.family_id, name: 'lead', version_id: created.id },
      message_id: sent.body.message.id,
      contact_id: CONTACT,
      device_id: OFFICIAL,
    });
    expect(event!.json.data.answers).toEqual([
      { key: 'nombre', label: 'Nombre', value: 'Ana' },
      { key: 'email', label: 'Email', value: 'contacto@example.com' },
      { key: 'rubro', label: 'Rubro', value: 'op_comercio' },
      { key: 'volumen', label: 'Chats por mes', value: 'op_mas_de_quinientos' },
    ]);
    // Once per run.
    expect((await api.call('POST', '/_sandbox/forms/complete', { message_id: sent.body.message.id })).body.event).toBeNull();

    const responses = await api.call('GET', `/api/v1/forms/families/${created.family_id}/responses`);
    expect(responses.body.meta.total).toBe(1);
    expect(responses.body.data[0]).toMatchObject({ status: { key: 'completed', label: 'Completado' }, origin: 'api', values: { nombre: 'Ana', volumen: 'Más de 500' } });
    expect(responses.body.columns.map((c: { name: string }) => c.name)).toEqual(['nombre', 'email', 'rubro', 'volumen']);

    const list = await api.call('GET', '/api/v1/forms');
    expect(list.body.data[0]).toMatchObject({ family_id: created.family_id, sends: 1, responses: 1 });
    expect(list.body.data[0].definition).toBeUndefined();
  });

  it('a new version is a draft; asking again returns the same one', async () => {
    const api = await startSandbox();
    const created = (await api.call('POST', '/api/v1/forms', { device_id: OFFICIAL, template_key: 'signup' })).body.data;
    await api.call('POST', `/api/v1/forms/${created.id}/publish`);
    const v2 = await api.call('POST', `/api/v1/forms/${created.id}/versions`);
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ created: true, data: { version: 2, name: 'signup__v2', label: 'signup', status: 'draft', family_id: created.family_id } });
    const again = await api.call('POST', `/api/v1/forms/${created.id}/versions`);
    expect(again).toMatchObject({ status: 200, body: { created: false, data: { id: v2.body.data.id } } });
    expect((await api.call('DELETE', `/api/v1/forms/${created.id}/numbers/${OFFICIAL}`)).body.error).toBe('PRIMARY_NUMBER');
  });
});
