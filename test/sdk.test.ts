/**
 * The Node SDK pointed at the sandbox with `baseUrl`, when its checkout is next to this repo
 * (FUNNELCHAT_NODE_SDK, or ../funnelchat-node). Skipped otherwise: the vendored copy in signature.test.ts already
 * covers the signature.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_KEY, startReceiver, startSandbox } from './helpers.js';

const sdkRoot = resolve(process.env.FUNNELCHAT_NODE_SDK ?? resolve(import.meta.dirname, '../../funnelchat-node'));
const entry = resolve(sdkRoot, 'src/index.ts');

describe.skipIf(!existsSync(entry))('the Node SDK against the sandbox', () => {
  it('lists, sends, subscribes and verifies the delivery with constructEvent', async () => {
    const { Funnelchat } = (await import(pathToFileURL(entry).href)) as { Funnelchat: any };
    const api = await startSandbox();
    const receiver = await startReceiver();
    const funnelchat = new Funnelchat({ apiKey: API_KEY, baseUrl: api.url, maxRetries: 0 });

    const devices = [];
    for await (const device of funnelchat.devices.list()) devices.push(device.id);
    expect(devices).toEqual([3, 4]);

    for (let i = 0; i < 3; i++) await funnelchat.contacts.create({ phone: `54911000010${i}`, name: `Contacto ${i}` });
    const contacts = [];
    for await (const contact of funnelchat.contacts.list({ perPage: 2 })) contacts.push(contact.id);
    expect(contacts).toHaveLength(4);

    const subscription = await funnelchat.webhooks.create({ url: receiver.url, events: ['message.received', 'message.status_changed'] });
    expect(typeof subscription.secret).toBe('string');

    await api.call('POST', '/_sandbox/inbound/message', { contact_id: 2001, device_id: 3, text: 'Hola' });
    const window = await funnelchat.contacts.metaWindow(2001, { device_id: 3 });
    expect(window.is_open).toBe(true);

    const sent = await funnelchat.messages.send(2001, { device_id: 3, phone: '5491100000000', text: '¡Hola!', client_reference: 'pedido-8841' });
    expect(sent.message).toMatchObject({ status: 'queued', client_reference: 'pedido-8841' });

    const deliveries = await receiver.waitFor(4);
    const events = deliveries.map((d) => Funnelchat.webhooks.constructEvent(d.raw, String(d.headers['x-funnelchat-signature']), subscription.secret));
    expect(events.map((e: { type: string; data: { status?: string } }) => e.data.status ?? e.type)).toEqual(['message.received', 'sent', 'delivered', 'read']);

    let error: any;
    try {
      await funnelchat.messages.send(2001, { device_id: 3, phone: '5491100000000', text: 'x' }, { headers: { 'X-Sandbox-Reject': 'window_closed' } });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ status: 422, code: 'window_closed' });
  });
});
