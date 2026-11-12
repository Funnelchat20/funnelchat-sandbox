/**
 * Every route of the spec with a handler of its own, by `METHOD /path` exactly as in the spec, and how the sandbox
 * answers each route: with state, closed to every key, or shape only (the rest, see `openapi/shape.ts`).
 */
import type { HandlerTable } from '../http/context.js';
import { connectLinkHandlers } from './connect-links.js';
import { contactHandlers } from './contacts.js';
import { deviceHandlers } from './devices.js';
import { formHandlers } from './forms.js';
import { GATE_CLOSED, gateHandlers } from './gate.js';
import { GROUP_ACTION_ROUTES, groupHandlers } from './groups.js';
import { messageHandlers } from './messages.js';
import { readTypingHandlers } from './read-typing.js';
import { webhookHandlers } from './webhooks.js';

export const handlers: HandlerTable = {
  ...contactHandlers,
  ...messageHandlers,
  ...readTypingHandlers,
  ...deviceHandlers,
  ...connectLinkHandlers,
  ...formHandlers,
  ...groupHandlers,
  ...gateHandlers,
  ...webhookHandlers,
};

/**
 * - `stateful`: a handler of its own, with state and events;
 * - `closed`: no key enables it, `403 route_not_available` (the gate's routes, and the group actions with
 *   `--no-group-actions`);
 * - `shape-only`: no handler, the answer of the spec with nothing stored or emitted.
 */
export type Simulation = 'stateful' | 'closed' | 'shape-only';

export function simulationOf(route: string, groupActions: boolean): Simulation {
  if (GATE_CLOSED.has(route) || (!groupActions && GROUP_ACTION_ROUTES.has(route))) return 'closed';
  return Object.hasOwn(handlers, route) ? 'stateful' : 'shape-only';
}
