/**
 * Group actions and join requests by API (communities v2.34.52, `GroupManagement/routes.php`): they exist, but are
 * off in production (`API_GROUP_ACTIONS_ENABLED` defaults to `false`). Off, the routes are out of the catalog the
 * gate lets through, so every API key gets the gate's `403 route_not_available` (platform-gate `RouteNotAvailable`).
 * The sandbox answers that, so an integration sees what production does today.
 */
import type { HandlerTable } from '../http/context.js';
import { routeNotAvailable } from '../http/errors.js';

export const GROUP_ACTION_ROUTES = [
  'GET /api/v1/groups/actions/{action}',
  'POST /api/v1/groups',
  'POST /api/v1/groups/{group}/participants',
  'POST /api/v1/groups/{group}/participants/remove',
  'POST /api/v1/groups/{group}/admins',
  'POST /api/v1/groups/{group}/admins/remove',
  'PUT /api/v1/groups/{group}/name',
  'PUT /api/v1/groups/{group}/description',
  'PUT /api/v1/groups/{group}/photo',
  'PUT /api/v1/groups/{group}/settings',
  'POST /api/v1/groups/{group}/invite-link/renew',
  'POST /api/v1/groups/{group}/messages',
  'GET /api/v1/groups/{group}/invite-link/live',
  'GET /api/v1/groups/{group}/join-requests',
  'POST /api/v1/groups/{group}/join-requests/approve',
  'POST /api/v1/groups/{group}/join-requests/reject',
];

/**
 * Every route the gate closes to API keys, by `METHOD /path` of the spec: the group actions above, and polls and events
 * (conversations took them out of `config/platform-gate.php`). The gate answers before any validation.
 */
export const GATE_CLOSED = new Set([...GROUP_ACTION_ROUTES, 'POST /api/v1/contacts/{contact}/message/poll', 'POST /api/v1/contacts/{contact}/message/event']);

export const groupHandlers: HandlerTable = Object.fromEntries(
  [...GATE_CLOSED].map((route) => [
    route,
    () => {
      throw routeNotAvailable();
    },
  ]),
);
