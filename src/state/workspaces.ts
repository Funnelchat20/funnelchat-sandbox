/**
 * Workspaces, as the API keys see them in production since 04-11 (accounts v1.5.97, conversations v1.19.7,
 * communities v2.35.5, platform-gate v0.9.1: workspaces-api-keys):
 *
 * - every key belongs to one workspace, and only reads, creates and changes there; `X-Workspace-Id` is ignored;
 * - lists show the rows of the key's workspace and, if that is the default one, also the rows without a workspace;
 * - a record of another workspace answers like one that does not exist (each domain with its own `404`);
 * - what a key creates lands in its workspace;
 * - an event reaches only the subscriptions of its workspace, and its `data.workspace_id` says which one.
 *
 * An account with a single workspace sees no change, except `data.workspace_id` in the events. In the sandbox any
 * well-formed key belongs to the default workspace; the keys minted with `POST /_sandbox/workspaces` or
 * `POST /_sandbox/keys` (or listed in the configuration) belong to theirs.
 */
import type { SandboxApp } from '../app.js';
import { randomAlnum } from '../util.js';
import type { Store, Workspace } from './store.js';

/** The workspace of the key that calls. */
export interface WorkspaceScope {
  id: number;
  isDefault: boolean;
}

/** Whether a row with that workspace is visible to the scope: its own, or one without a workspace from the default one. */
export function sees(scope: WorkspaceScope, workspaceId: number | null): boolean {
  return workspaceId === null ? scope.isDefault : workspaceId === scope.id;
}

export function scopeOf(workspace: Workspace): WorkspaceScope {
  return { id: workspace.id, isDefault: workspace.isDefault };
}

/** The workspace of a key: the one it was minted for, or the default one. */
export function scopeOfKey(store: Store, key: string): WorkspaceScope {
  const id = store.keys.get(key)?.workspaceId;
  const workspace = id === undefined ? undefined : store.workspaces.get(id);
  return scopeOf(workspace ?? store.defaultWorkspace);
}

/** The permissions of a key (`null`: every one, as any key the sandbox did not mint with a list). */
export const permissionsOfKey = (store: Store, key: string): string[] | null => store.keys.get(key)?.permissions ?? null;

/** The literal permissions of a key (platform-gate): `area:level`. */
export const PERMISSION = /^(accounts|conversations|communities|webhooks):(read|write|send|operate)$/;

/** The default workspace's scope: what the `/_sandbox` routes (no key) act as when they create something. */
export const defaultScope = (store: Store): WorkspaceScope => scopeOf(store.defaultWorkspace);

/**
 * The workspace an event is routed to (accounts `WorkspaceRoute`): the one declared, when it is a workspace of the
 * account; otherwise the default one.
 */
export function routedWorkspace(store: Store, declared: number | null | undefined): number {
  if (declared !== null && declared !== undefined && store.workspaces.has(declared)) return declared;
  return store.defaultWorkspace.id;
}

/** A new sandbox key for a workspace: `<id>|fc_live_<40 letters and digits>`, the shape of a real one. */
export function mintKey(store: Store, workspaceId: number, fixed?: string, permissions: string[] | null = null): string {
  const key = fixed ?? `${store.ids.apiKey.next()}|fc_live_${randomAlnum(40)}`;
  store.keys.set(key, { workspaceId, permissions });
  return key;
}

export function createWorkspace(app: SandboxApp, name: string, now = new Date()): Workspace {
  const workspace: Workspace = { id: app.store.ids.workspace.next(), name, isDefault: false, createdAt: now };
  app.store.workspaces.set(workspace.id, workspace);
  return workspace;
}

/** What `/_sandbox/workspaces` shows of a workspace: never the keys of other workspaces, and the keys only here. */
export function workspaceView(store: Store, workspace: Workspace): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    is_default: workspace.isDefault,
    keys: [...store.keys.entries()].filter(([, k]) => k.workspaceId === workspace.id).map(([key]) => key),
  };
}
