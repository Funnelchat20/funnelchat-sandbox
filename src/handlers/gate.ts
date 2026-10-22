/**
 * The routes the gate closes to API keys, by `METHOD /path` of the spec: polls and events (conversations took them
 * out of `config/platform-gate.php`). Every API key gets the gate's `403 route_not_available` (platform-gate
 * `RouteNotAvailable`), before any validation. The sandbox answers that, so an integration sees what production does.
 */
import type { HandlerTable } from '../http/context.js';
import { routeNotAvailable } from '../http/errors.js';

export const GATE_CLOSED = new Set(['POST /api/v1/contacts/{contact}/message/poll', 'POST /api/v1/contacts/{contact}/message/event']);

export const gateHandlers: HandlerTable = Object.fromEntries(
  [...GATE_CLOSED].map((route) => [
    route,
    () => {
      throw routeNotAvailable();
    },
  ]),
);
