/**
 * The portal's recipes, step by step, with the bodies they show: what a developer copies has to work in the sandbox.
 */
import { describe, expect, it } from 'vitest';
import { startReceiver, startSandbox, subscribe } from './helpers.js';

describe('recipe «Plantilla con variables» (content/recetas/plantilla-con-variable.md)', () => {
  it('the official number, the webhook, the template, its approval and the send, with and without template_variables', async () => {
    const api = await startSandbox({ templateApprovalSeconds: 0.05 });
    const receiver = await startReceiver();

    // 1. The official number: `connection` `coexistence` or `dedicated`.
    const devices = (await api.call('GET', '/api/v1/devices')).body.data as { id: string; connection: string }[];
    const official = devices.find((d) => d.connection === 'coexistence' || d.connection === 'dedicated');
    expect(official).toBeDefined();
    const device = official!.id;

    // 2. Once, the webhook with template.status_changed.
    await subscribe(api, receiver.url, ['template.status_changed']);

    // 3. The template, with the recipe's body.
    const created = await api.call('POST', '/api/v1/templates', {
      device_id: device,
      name: 'pedido_listo',
      language_code: 'es',
      category: 'UTILITY',
      type: 'text',
      body: 'Hola {{1}}, tu pedido ya está listo para retirar.',
      params: { body: { 1: '{name}' }, samples: { body: { 1: 'Lucía' } } },
    });
    expect(created.status).toBe(201);
    const template = created.body;
    expect(template.id).toMatch(/^tpl_[A-Za-z0-9]{23}$/);
    expect(template.status).toBe('PENDING');

    // 4. The approval arrives as template.status_changed; GET gives its status too.
    const [event] = await receiver.waitFor(1);
    expect(event!.json).toMatchObject({ type: 'template.status_changed', data: { template: { id: template.id }, status: 'APPROVED', previous_status: 'PENDING' } });
    expect((await api.call('GET', `/api/v1/templates/${template.id}`)).body.status).toBe('APPROVED');

    // 5. Send it by phone, with your text for {{1}}…
    const path = `/api/v1/devices/${device}/templates/${template.id}/send-template`;
    const sent = await api.call('POST', path, { phone: '5491122334455', template_variables: { body: { '1': 'Lucía' } } });
    expect(sent.status).toBe(200);
    expect(sent.body.message).toMatchObject({ type: 'template', status: 'queued', device_id: device });
    const contactId = sent.body.message.contact_id as string;
    const history = (await api.call('GET', `/api/v1/contacts/${contactId}/messages`)).body.data as { id: string; text: string }[];
    expect(history.find((m) => m.id === sent.body.message.id)?.text).toBe('Hola Lucía, tu pedido ya está listo para retirar.');

    // …or without template_variables: {{1}} takes the field chosen in params.body, the contact's name.
    await api.call('PUT', `/api/v1/contacts/${contactId}`, { name: 'Carla' });
    const byField = await api.call('POST', path, { phone: '5491122334455' });
    expect(byField.status).toBe(200);
    const again = (await api.call('GET', `/api/v1/contacts/${contactId}/messages`)).body.data as { id: string; text: string }[];
    expect(again.find((m) => m.id === byField.body.message.id)?.text).toBe('Hola Carla, tu pedido ya está listo para retirar.');
  });
});
