/**
 * Groups as communities v2.35.5 answers them to an API key: the list and one group with state, the send of a message
 * to a group (a group action, behind communities' kill switch) and the participant events.
 */
import { describe, expect, it } from 'vitest';
import { startReceiver, startSandbox, subscribe } from './helpers.js';

const UID = '120363000000000000@g.us';

describe('the groups of the account', () => {
  it('lists them with the shape of communities, 25 per page and a closed sort for a key', async () => {
    const api = await startSandbox();
    const res = await api.call('GET', '/api/v1/groups');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['data', 'links', 'meta']);
    expect(res.body.meta).toMatchObject({ per_page: 25, total: 1, cloud_api_groups_enabled: false });
    const [group] = res.body.data;
    expect(Object.keys(group)).toEqual([
      'id', 'admins_numbers', 'admins', 'admins_count', 'owner', 'owner_display_phone', 'owner_connected', 'clicks', 'communityUid',
      'newsletterUid', 'description', 'deviceId', 'image', 'isFull', 'isApi', 'link', 'campaign_link', 'campaign_custom_domain', 'name',
      'order', 'participants_numbers', 'participants_count', 'read_rate', 'read_rate_messages_count', 'status', 'uid', 'updatedAt',
      'createdAt', 'scheduled_message_count', 'type', 'manual_import', 'participantMode', 'ownNumbers', 'adminOnlyMessage', 'origin', 'lastSyncAt',
    ]);
    expect(group).toMatchObject({
      uid: UID,
      name: 'Grupo de ejemplo',
      deviceId: 4,
      participants_count: 2,
      admins: [{ phone: '5491100000002', lid: null, isConnected: true, accessDenied: false, displayPhone: '5491100000002' }],
      ownNumbers: [{ deviceId: 4, phone: '5491100000002', role: 'admin' }],
      type: 1,
      status: 0,
    });
    expect(group.createdAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

    expect(await api.call('GET', '/api/v1/groups?perPage=101')).toMatchObject({
      status: 422,
      body: { message: 'Con una API key, `perPage` admite como máximo 100 elementos por página.' },
    });
    expect((await api.call('GET', '/api/v1/groups?orderBy=participants')).body.errors.orderBy).toEqual(['`orderBy` solo acepta: created_at, id, name, updated_at.']);
    expect((await api.call('GET', '/api/v1/groups?orderByMethod=DESC')).status).toBe(422);
  });

  it('shows one by its uid, and one that does not exist answers the 404 of the model binding', async () => {
    const api = await startSandbox();
    const res = await api.call('GET', `/api/v1/groups/${encodeURIComponent(UID)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uid: UID, ownNumbers: null, admins: [{ isConnected: false }] });
    expect(await api.call('GET', '/api/v1/groups/120363999999999999@g.us')).toMatchObject({
      status: 404,
      body: { message: 'No query results for model [App\\Modules\\Shared\\Models\\Group] 120363999999999999@g.us' },
    });
  });
});

describe('sending a message to a group', () => {
  it('with --no-group-actions (the switch off): 403 route_not_available before any validation', async () => {
    const api = await startSandbox({ groupActions: false });
    const res = await api.call('POST', `/api/v1/groups/${encodeURIComponent(UID)}/messages`, {});
    expect(res).toMatchObject({ status: 403, body: { error: 'route_not_available' } });
    expect((await api.call('GET', '/api/v1/groups/actions/7c9e6679-7425-40de-944b-e07fc1f90ae7')).status).toBe(403);
  });

  it('on by default, like production: 202 with action_id, then running, completed and group_action.completed', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['group_action.completed']);
    const res = await api.call('POST', `/api/v1/groups/${encodeURIComponent(UID)}/messages`, { device_id: 4, type: 'text', text: 'Hola a todos' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ action_id: expect.stringMatching(/^[0-9a-f-]{36}$/), status: 'queued' });

    const [event] = await receiver.waitFor(1);
    expect(event!.json.data).toEqual({
      action: { uuid: res.body.action_id, type: 'send_message' },
      group: { uid: UID, name: 'Grupo de ejemplo' },
      campaign: null,
      result: { message: { uid: expect.any(String) } },
      workspace_id: 1,
    });
    const action = await api.call('GET', `/api/v1/groups/actions/${res.body.action_id}`);
    expect(action.body.data).toMatchObject({
      action_id: res.body.action_id,
      type: 'send_message',
      status: 'completed',
      device_id: 4,
      group: { uid: UID, name: 'Grupo de ejemplo' },
      result: { message: { uid: event!.json.data.result.message.uid } },
      reason: null,
      failed_at: null,
    });
    expect(action.body.data.completed_at).toMatch(/\+00:00$/);
  });

  it('refuses like communities: the body, the number, the group and the official number without the beta', async () => {
    const api = await startSandbox();
    const path = `/api/v1/groups/${encodeURIComponent(UID)}/messages`;
    expect((await api.call('POST', path, { device_id: 4, type: 'text' })).body.errors.text).toBeDefined();
    expect((await api.call('POST', path, { device_id: 4, type: 'image', media_url: 'http://example.com/a.jpg' })).body.errors.media_url).toEqual([
      'El archivo debe ser una URL https con una extensión admitida para ese tipo de mensaje.',
    ]);
    expect(await api.call('POST', path, { device_id: 99, type: 'text', text: 'x' })).toMatchObject({ status: 404, body: { error: 'device_not_found' } });
    expect(await api.call('POST', '/api/v1/groups/120363999999999999@g.us/messages', { device_id: 4, type: 'text', text: 'x' })).toMatchObject({
      status: 404,
      body: { error: 'group_not_found', message: 'No encontramos ese grupo en tu cuenta.' },
    });
    expect(await api.call('POST', path, { device_id: 3, type: 'text', text: 'x' })).toMatchObject({
      status: 422,
      body: { error: 'provider_unsupported', provider: 'official', requires: 'cloud-api-groups' },
    });
    await api.call('POST', '/_sandbox/devices/4/disconnect');
    expect(await api.call('POST', path, { device_id: 4, type: 'text', text: 'x' })).toMatchObject({ status: 422, body: { error: 'device_not_connected' } });
    expect((await api.call('GET', '/api/v1/groups/actions/7c9e6679-7425-40de-944b-e07fc1f90ae7')).body.error).toBe('action_not_found');
  });
});

describe('participants', () => {
  it('a participant joins and leaves a group of the sandbox: the group changes and the events go out as communities emits them', async () => {
    const api = await startSandbox();
    const receiver = await startReceiver();
    await subscribe(api, receiver.url, ['group_participant.joined', 'group_participant.left']);
    const joined = await api.call('POST', '/_sandbox/groups/participant-joined', { participant: { phone: '+54 9 11 5555-0123', name: 'Lucía' } });
    expect(joined.body.participants).toBe(3);
    await api.call('POST', '/_sandbox/groups/participant-left', { group_id: 7001, participant: { phone: '5491155550123' } });
    const [first, second] = await receiver.waitFor(2);
    expect(first!.json.data).toEqual({
      group: { uid: UID, name: 'Grupo de ejemplo' },
      campaign: null,
      participant: { identity: '5491155550123', identity_type: 'phone', name: 'Lucía' },
      workspace_id: 1,
    });
    expect(second!.json.type).toBe('group_participant.left');
    expect(second!.json.data.participant.name).toBe('Lucía');
    expect((await api.call('GET', `/api/v1/groups/${encodeURIComponent(UID)}`)).body.participants_count).toBe(2);
  });
});

describe('following a group (communities v2.35.7)', () => {
  it('the live list shows what is not imported; import follows it, and a send imports first', async () => {
    const api = await startSandbox();
    const live = await api.call('GET', '/api/v1/devices/4/groups');
    expect(live.body.data.map((g: { uid: string; device_id: unknown }) => [g.uid, g.device_id])).toEqual([
      [UID, 4],
      ['120363000000000001@g.us', ''],
    ]);
    const vip = '120363000000000001@g.us';
    const followed = await api.call('POST', `/api/v1/groups/${encodeURIComponent(vip)}/import`, { device_id: 4 });
    expect(followed).toMatchObject({ status: 201, body: { data: { uid: vip, name: 'Clientes VIP', imported: true, is_admin: true } } });
    expect((await api.call('POST', `/api/v1/groups/${encodeURIComponent(vip)}/import`, { device_id: 4 })).status).toBe(200);
    expect(await api.call('POST', `/api/v1/groups/${encodeURIComponent(UID)}/import`, { device_id: 3 })).toMatchObject({ status: 422, body: { error: 'provider_unsupported' } });

    // A send to a group the account does not have imports it first; the number must be its admin.
    const other = await api.call('POST', '/_sandbox/groups', { device_id: 4, name: 'Solo participante', imported: false, admin: false });
    const sent = await api.call('POST', `/api/v1/groups/${encodeURIComponent(other.body.group.uid)}/messages`, { device_id: 4, type: 'text', text: 'Hola' });
    expect(sent).toMatchObject({ status: 422, body: { error: 'device_not_group_admin' } });
    const keyed = await api.call('POST', '/_sandbox/keys', { permissions: ['communities:send'] });
    const fresh = await api.call('POST', '/_sandbox/groups', { device_id: 4, name: 'Nuevo', imported: false });
    expect(
      await api.call('POST', `/api/v1/groups/${encodeURIComponent(fresh.body.group.uid)}/messages`, { device_id: 4, type: 'text', text: 'x' }, { Authorization: `Bearer ${keyed.body.key}` }),
    ).toMatchObject({ status: 403, body: { error: 'import_permission_required' } });
    expect((await api.call('POST', `/api/v1/groups/${encodeURIComponent(fresh.body.group.uid)}/messages`, { device_id: 4, type: 'text', text: 'x' })).status).toBe(202);
    expect((await api.call('GET', '/api/v1/groups')).body.meta.total).toBe(3);
  });
});

describe('groups and workspaces', () => {
  it('a key only sees the groups of its workspace, and their events go to its subscriptions', async () => {
    const api = await startSandbox();
    const created = await api.call('POST', '/_sandbox/workspaces', { name: 'Cliente B' });
    const asB = (method: string, path: string, body?: unknown) => api.call(method, path, body, { Authorization: `Bearer ${created.body.key}` });
    const device = await asB('POST', '/api/v1/devices', { connection: 'qr' });
    await api.call('POST', `/_sandbox/devices/${device.body.data.id}/connect`);
    const group = await api.call('POST', '/_sandbox/groups', { device_id: device.body.data.id, name: 'Clientes B', participants: ['5491155550200'] });
    expect(group.status).toBe(201);
    const uid = group.body.group.uid as string;

    expect((await asB('GET', '/api/v1/groups')).body.data.map((g: { uid: string }) => g.uid)).toEqual([uid]);
    expect((await api.call('GET', '/api/v1/groups')).body.data.map((g: { uid: string }) => g.uid)).toEqual([UID]);
    expect((await asB('GET', `/api/v1/groups/${encodeURIComponent(UID)}`)).status).toBe(404);
    expect((await asB('POST', `/api/v1/groups/${encodeURIComponent(UID)}/messages`, { device_id: 4, type: 'text', text: 'x' })).body.error).toBe('device_not_found');

    const receiver = await startReceiver();
    await asB('POST', '/api/v1/webhooks', { url: receiver.url, events: ['group_participant.joined'] });
    await api.call('POST', '/_sandbox/groups/participant-joined', { uid, participant: { phone: '5491155550201' } });
    const [event] = await receiver.waitFor(1);
    expect(event!.json.data.workspace_id).toBe(created.body.workspace.id);
  });
});
