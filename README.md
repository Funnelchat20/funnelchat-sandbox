# @funnelchat-hq/sandbox

A local server that imitates the Funnelchat public API and sends signed webhooks, with no real effects: nothing goes out to WhatsApp, nothing is charged, everything stays in memory. Build and test your integration without an account.

It comes from the spec the developer portal publishes, v0.6.14: the same operations and events (see [Pending of the spec](#pending-of-the-spec)). What it simulates with state follows production as it was checked on 06-11.

## Try it in 3 minutes, without an account

You need Node 20.11 or later. Start the sandbox and leave it running:

```bash
npx @funnelchat-hq/sandbox
```

In another terminal, the key. Against the sandbox any well-formed key works; against Funnelchat you create it in the panel (Developers → Create key) and it is shown only once. Either way, read it from `FUNNELCHAT_API_KEY`:

```bash
export FUNNELCHAT_API_KEY='1|fc_live_sandbox'
API=http://localhost:4010/api/v1
```

**1. Connect a number.** Create a number by QR, ask for its QR and "scan" it (in the sandbox the scan is a route, or the **Scan the QR** button of the panel):

```bash
curl -s -X POST $API/devices -H "Authorization: Bearer $FUNNELCHAT_API_KEY" \
  -H 'Content-Type: application/json' -d '{"connection": "qr"}'
# {"data": {"id": 5, "connected": 0, "connection": "qr", …}}
curl -s $API/devices/5/qr -H "Authorization: Bearer $FUNNELCHAT_API_KEY"
# {"data": {"connected": false, "qr_code": "data:image/png;base64,…", "expires_in": 5}}: show it, ask again every 5 s
curl -s -X POST http://localhost:4010/_sandbox/devices/5/connect
# device.connected: number 5 is connected
```

**2. Send a message.** One call, by phone, through number 5: if the phone is not a contact yet, it becomes one.

```bash
curl -s -X POST $API/message/send-message -H "Authorization: Bearer $FUNNELCHAT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"device_id": 5, "phone": "5491155550000", "text": "Hola, Ana", "client_reference": "pedido-8841"}'
# {"message": {"id": 9001, "contact_id": 2002, "status": "queued", "client_reference": "pedido-8841", …}}
```

**3. Know when it was read.** Within six seconds the message goes `sent` → `delivered` → `read`. Watch it at [http://localhost:4010/_sandbox](http://localhost:4010/_sandbox), under **Events** (every `message.status_changed`, delivered or not), or read the message:

```bash
curl -s $API/contacts/2002/messages/9001 -H "Authorization: Bearer $FUNNELCHAT_API_KEY"   # 2002: the contact_id of the answer
# {"id": 9001, "status": "read", …}
```

In your code, subscribe a webhook to `message.status_changed` and verify its signature (see [Webhooks](#webhooks) and [End to end](#end-to-end)). That is the whole first use; against Funnelchat it is the same calls with your key and `https://api.funnelchat.com` instead of `http://localhost:4010`.

### Receive messages

A contact writes to one of your numbers: the sandbox creates the contact if it is new (`contact.created`) and emits `message.received`, with the `device_id` that received it. From the panel (**Incoming message**) or:

```bash
curl -s -X POST http://localhost:4010/_sandbox/inbound/message -H 'Content-Type: application/json' \
  -d '{"phone": "5491155550000", "device_id": 5, "text": "¿Tienen stock?"}'
```

On an official number (`3`) this also opens the 24-hour window: free text only goes out within it, after that only [templates](#sending-a-message).

### Groups

Groups start from your number's live list: `GET /api/v1/devices/{device}/groups` reads the groups the number is in on WhatsApp (QR numbers), and `device_id` says which ones the account already has. The sandbox's QR number `4` is in two: `120363000000000000@g.us` («Grupo de ejemplo», already in the account) and `120363000000000001@g.us` («Clientes VIP», not yet).

```bash
curl -s "$API/devices/4/groups" -H "Authorization: Bearer $FUNNELCHAT_API_KEY"
# {"data": [{"uid": "120363000000000000@g.us", "name": "Grupo de ejemplo", "device_id": 4, …}, {"uid": "120363000000000001@g.us", "name": "Clientes VIP", "device_id": "", …}], "meta": {…}}
```

**Follow a group** to know who joins and leaves: `POST /api/v1/groups/{uid}/import` with `device_id` imports it to the account, as the panel does (`201`, or `200` if it already was there, with `is_admin` read from WhatsApp). From then on it is in `GET /api/v1/groups` and `GET /api/v1/groups/{uid}`, and announces `group_participant.joined` and `group_participant.left` (`group`, `campaign`, `null` without one, and `participant`, whose `identity` is the phone in digits). It needs the permission **Grupos y campañas → Administrar grupos** (`403 import_permission_required`), only QR numbers (`422 provider_unsupported`), and each number imports up to 5 groups per minute (`429 import_rate_limited`, with `Retry-After`).

```bash
curl -s -X POST "$API/groups/120363000000000001@g.us/import" -H "Authorization: Bearer $FUNNELCHAT_API_KEY" \
  -H 'Content-Type: application/json' -d '{"device_id": 4}'
# 201 {"data": {"uid": "120363000000000001@g.us", "name": "Clientes VIP", "imported": true, "is_admin": true}}
curl -s -X POST http://localhost:4010/_sandbox/groups/participant-joined -H 'Content-Type: application/json' \
  -d '{"uid": "120363000000000001@g.us", "participant": {"phone": "5491155550000", "name": "Ana"}}'
# group_participant.joined (a group the account does not have announces nothing)
```

**Writing to a group** is `POST /api/v1/groups/{uid}/messages`, a group action: it answers `202` with an `action_id`, and `GET /api/v1/groups/actions/{action}` says when it is `completed` (with `result.message.uid`, the message's id in WhatsApp), as does the event `group_action.completed`. A group the account does not have is imported first, with the same rules (and the number must be its admin):

```bash
curl -s -X POST "$API/groups/120363000000000000@g.us/messages" -H "Authorization: Bearer $FUNNELCHAT_API_KEY" \
  -H 'Content-Type: application/json' -d '{"device_id": 4, "type": "text", "text": "Hola a todos"}'
# 202 {"action_id": "…", "status": "queued"}
```

`type` is `text` (with `text`), `image`, `video`, `audio` or `document` (with `media_url`, an `https` URL with an extension of the type; `caption` for `image` and `video`, `file_name` for `document`). The number must be a QR number that is an admin of the group: `404 device_not_found` or `group_not_found`, `422 device_not_connected`, `device_not_group_admin` or, for an official number, `provider_unsupported` (the sandbox account is not in the beta of official groups). Two imports of the same group at a time cannot happen in the sandbox; `X-Sandbox-Reject: import_in_progress` gives production's `409`. A key minted with `POST /_sandbox/keys` and `"permissions": ["communities:send"]` lacks the permission to import. To imitate communities' switch `API_GROUP_ACTIONS_ENABLED` off, start it with `--no-group-actions`: every key then gets `403 route_not_available`.

### Workspaces

An account can have several workspaces (one per client of an agency, for example), and every key belongs to one: it only sees and operates the numbers, contacts, conversations, messages, groups and webhook subscriptions of its workspace, and what it creates lands there. A record of another workspace answers like one that does not exist (`404`). Every event carries `data.workspace_id`, the workspace it belongs to, and reaches only the subscriptions of that workspace.

The sandbox starts with one workspace, `1` («Principal»), and every well-formed key belongs to it, so nothing above changes. To try a second one, create it with its key (in production it is created in the panel, and its keys in Developers):

```bash
curl -s -X POST http://localhost:4010/_sandbox/workspaces -H 'Content-Type: application/json' -d '{"name": "Cliente B"}'
# {"workspace": {"id": 2, "name": "Cliente B", "is_default": false, "keys": ["101|fc_live_…"]}, "key": "101|fc_live_…"}
```

With that key, `GET /api/v1/devices` is empty until you connect a number there, and its events go out with `"workspace_id": 2`. `POST /_sandbox/keys` (`{"workspace_id": 2}`) gives another key, `GET /_sandbox/workspaces` lists them, and the configuration file can create workspaces with fixed keys (see [Options](#options)).

## Reference

**About the language.** This documentation, the command line, the panel and the sandbox's own routes (`/_sandbox`) are in English. The answers under `/api/v1` imitate the API, which answers in Spanish, so their messages are in Spanish, word for word where they come from the API's code. Decide by the HTTP status and by `error`, never by `message`.

What it imitates, beyond the first use:

- The same routes, bodies and errors as the API in production, validated against its spec.
- In-memory state for a real flow: numbers and sign-up links, contacts, conversations and messages, groups, tags, custom fields, templates, WhatsApp forms and webhook subscriptions, in one or more workspaces.
- A send answers at once with the queued message, and then announces `sent`, `delivered` and `read` through `message.status_changed`.
- Webhooks signed with the portal's exact algorithm, with its retries, and the event catalog of production.
- The WhatsApp rules the API applies: the 24-hour window on official numbers, the per-number pace, the spam brakes and the MAC lockout.
- `X-Request-Id` on every response, like the API.
- Every other operation of the spec, **shape only**: validated like the rest, it answers the spec's success status with a body that fits the response schema, keeps nothing and emits nothing, and says so in `X-Sandbox-Simulated: shape-only`. See [With state or shape only](#with-state-or-shape-only).

What it does not imitate is in [What it does not imitate](#what-it-does-not-imitate).

## Starting it

You need Node 20.11 or later. `npx @funnelchat-hq/sandbox` starts it; or, in your project, as a development dependency (the command it installs is `funnelchat-sandbox`):

```bash
npm install --save-dev @funnelchat-hq/sandbox
npx funnelchat-sandbox
```

```
funnelchat-sandbox 0.5.0 at http://127.0.0.1:4010
  API:    http://127.0.0.1:4010/api/v1/...   (Authorization: Bearer 1|fc_live_sandbox, or any well-formed key)
  panel:  http://127.0.0.1:4010/_sandbox
  example numbers: 3 (official, with the 24-hour window) and 4 (QR, no window); contact 2001; template 45
```

**From the source:**

```bash
git clone https://github.com/Funnelchat20/funnelchat-sandbox.git
cd funnelchat-sandbox
npm install
npm run build
npx funnelchat-sandbox
```

**With Docker** (from the source):

```bash
docker build -t funnelchat-sandbox .
docker run --rm -p 127.0.0.1:4010:4010 funnelchat-sandbox
# with your configuration:
docker run --rm -p 127.0.0.1:4010:4010 -v "$PWD/funnelchat-sandbox.config.json:/app/funnelchat-sandbox.config.json:ro" funnelchat-sandbox
```

Inside the container it listens on `0.0.0.0`; `127.0.0.1:` publishes the port only on your machine (with `-p 4010:4010` the whole network reaches the sandbox, which takes no key on `/_sandbox`). If your webhook receiver runs on your machine, from the container it is `http://host.docker.internal:<port>` (on Linux, add `--add-host=host.docker.internal:host-gateway`).

**From your tests**, with no other process:

```ts
import { createSandbox } from '@funnelchat-hq/sandbox';

const sandbox = createSandbox({ config: { port: 0, log: false, statusDelays: { sent: 0.05, delivered: 0.05, read: 0.05 } } });
const { url } = await sandbox.listen(); // port 0: a free port
// … point your SDK at `url` …
await sandbox.close();
```

### Options

| Option | What it does | Default |
|---|---|---|
| `-p`, `--port <n>` | The port. `0` takes a free one. | `4010` |
| `--host <host>` | Where it listens. | `127.0.0.1` (in Docker, `0.0.0.0`) |
| `--public-url <url>` | The base of the sign-up links' `url` (`<url>/connect/<token>`). Set it when the sandbox is reached through another address, as in Docker. | Where it listens |
| `-c`, `--config <file>` | A JSON configuration file. | `./funnelchat-sandbox.config.json`, if it exists |
| `--status-delays <s,d,r>` | Seconds until `sent`, from there to `delivered` and from there to `read`. A `-` stops there (for example `1,2,-`: never read). | `1,2,3` |
| `--retry-delays <a,b,c>` | Seconds between the attempts of a webhook delivery. | `60,300,1800`, like the portal |
| `--webhook-timeout <s>` | How long it waits for your receiver's answer. | `10` |
| `--require-https` | Only accept `https` subscriptions, like the real API. | off |
| `--no-window` | Do not apply the 24-hour window. | — |
| `--no-antiblock` | Do not apply the spam brakes. | — |
| `--no-rate-limit` | Do not apply the per-number pace. | — |
| `--template-approval <s>` | Seconds until a template created through the API is approved. A `-` leaves it pending. | `5` |
| `--meta-connect` | Turns on the [Meta sign-up by link](#connecting-numbers), off like in production. | off |
| `--no-group-actions` | Turns off [sending a message to a group](#groups) (`403 route_not_available`), on like in production. | on |
| `-q`, `--quiet` | No line per request and per delivery on the console. | — |

Options win over the file. The file has the same options and, besides, subscriptions created at start (and after every reset) with a fixed secret, so your receiver keeps working when you restart the sandbox:

```json
{
  "statusDelays": { "sent": 1, "delivered": 2, "read": 3 },
  "webhooks": { "retryDelays": [5, 15, 30], "timeoutSeconds": 10 },
  "rules": { "window": true, "antiblock": true, "rateLimit": true },
  "subscriptions": [
    {
      "url": "http://localhost:3000/hooks/funnelchat",
      "events": ["message.received", "message.status_changed", "contact.created"],
      "secret": "whsec_desarrolloLocalNoUsarEnProduccion"
    }
  ]
}
```

The file also takes `groupActions` (`false` is `--no-group-actions`), `numbers`, the quota of the account for [connecting numbers](#connecting-numbers): `{"limit": 5, "included": true, "trial": false, "metaConnect": false, "linksPerMinute": 10}`, and `publicUrl`. `metaConnect`
is the Meta sign-up by link: off by default, like production; `true` (or `--meta-connect`) turns it on to test it.

And `workspaces`, more [workspaces](#workspaces) with fixed keys, created after the default one (ids `2`, `3`… in order): `[{"name": "Cliente B", "keys": ["2|fc_live_clienteB"]}]`. Any key not listed there belongs to the default workspace; the preset subscriptions too.

There is a complete one in [funnelchat-sandbox.config.example.json](funnelchat-sandbox.config.example.json). The file `funnelchat-sandbox.config.json` is in `.gitignore`: do not commit a secret, even a test one.

## The key

Any key with the shape of a real one works: `Authorization: Bearer <id>|fc_live_<letters and digits>`, for example `1|fc_live_sandbox`. It belongs to the default workspace, unless it was minted for another one ([workspaces](#workspaces)); `X-Workspace-Id` is ignored, as in production. Without a key, or with a malformed one, it answers `401` like the API:

```json
{ "error": "unauthenticated", "message": "Falta la API key o no es válida." }
```

Every key has every permission.

**Every response carries `X-Request-Id`**, like the API: a different UUID v4 per request, also on errors (`401`, `404 route_not_found`, `422`…) and on the `/_sandbox` routes. It is only in the header, never in the body, and one you send in the request is ignored. The panel shows it next to each response, so you can quote it as you would quote the API's.

## Pointing the SDKs at the sandbox

Change only the base URL. Everything else is the same as against the real API.

**Node** ([funnelchat-node](https://github.com/Funnelchat20/funnelchat-node)):

```ts
import { Funnelchat } from '@funnelchat-hq/sdk';

const funnelchat = new Funnelchat({ apiKey: '1|fc_live_sandbox', baseUrl: 'http://localhost:4010' });
```

**PHP** ([funnelchat-php](https://github.com/Funnelchat20/funnelchat-php)):

```php
$funnelchat = new \Funnelchat\Funnelchat(apiKey: '1|fc_live_sandbox', baseUrl: 'http://localhost:4010');
```

**The n8n node** ([n8n-nodes-funnelchat](https://github.com/Funnelchat20/n8n-nodes-funnelchat), `@funnelchat-hq/n8n-nodes-funnelchat` on npm): in the credential, the custom environment with the base URL `http://localhost:4010` (or `http://host.docker.internal:4010` if n8n runs in Docker and the sandbox on your machine). The trigger creates its subscription with `POST /api/v1/webhooks`, which the sandbox accepts over `http`. Since n8n sends no headers of its own, arm the failures beforehand with [`POST /_sandbox/failures`](#forcing-failures).

## What is inside

Every session starts with this:

| What | Id | What for |
|---|---|---|
| Official number (WhatsApp Cloud API) | `3` | It has the 24-hour window and the pace, and it is the only one that takes forms. `provider: 2`. |
| QR number | `4` | No window and no pace. `provider: 1`. |
| Contact «Contacto de ejemplo» | `2001` | Phone `5491100000000`. |
| Tag «Cliente» | `4001` | |
| Template `bienvenida`, approved, of number 3 | `45` | One variable: «Hola {{1}}, gracias por escribirnos…». |
| Group «Grupo de ejemplo» of number 4 | `7001`, `120363000000000000@g.us` | In the account. Number 4 is its admin; contact 2001, a participant. |
| Group «Clientes VIP» of number 4 | `120363000000000001@g.us` | Only on WhatsApp, to follow (import). Number 4 is its admin. |
| Workspace «Principal» | `1` | The default one: every key belongs to it unless it was minted for another. |

`POST /_sandbox/reset` goes back to this and cancels everything that was scheduled.

**With state** (what you create, change or delete stays): contacts (`/api/v1/contacts…`, with their tags, fields and the `meta-window`), conversations (`/api/v1/conversations…`), messages (send, history, reactions, forward, cards, the lookup by id, mark as read and «typing…»), tags, custom fields, templates, [WhatsApp forms](#whatsapp-forms), numbers and sign-up links ([connecting numbers](#connecting-numbers)), [groups](#groups) (the list, one group and the send) and webhook subscriptions with their history, in one or more [workspaces](#workspaces).

**The numbers** are those of accounts: `GET /api/v1/devices` always paginates (`{data, links, meta}`, `perPage` from 1 to 100), and each number carries `capabilities`, with what the API can do through it:

```json
{
  "messages": { "text": true, "media": true, "buttons": true, "lists": true, "templates": true, "location": true, "voice_note": true, "polls": false, "events": false, "contact_card": true, "reactions": false },
  "groups": { "create": false, "add_participants": false, "remove_participants": false, "admins": false, "photo": false, "settings": false, "invite_link": false, "send": false, "join_requests": false },
  "statuses": ["sent", "delivered", "read", "failed"]
}
```

The official number (`3`) has no groups (the sandbox account is not in the official groups beta); the QR one (`4`) does, and has no templates. `health` is `null` on the QR number.

**Polls and events** (`/message/poll`, `/message/event`) are closed to API keys in production (`403 route_not_available`) and the published spec does not carry them, so here they are not routes: `404 route_not_found`.

**Everything else** in the spec (broadcasts, flows, kanban boards, contact notes, the rest of groups, campaigns, alerts, the account…) answers **shape only**: see [With state or shape only](#with-state-or-shape-only).

**Validation** follows the spec and reads values like Laravel (`"5"` works as an integer, `"1"` as a boolean). A validation error is a `422` with Laravel's messages per field; a route that does not exist, `404 route_not_found`:

```json
{
  "error": "validation_failed",
  "message": "El campo device_id es obligatorio. (y 1 error más)",
  "errors": {
    "device_id": ["El campo device_id es obligatorio."],
    "contact_id": ["El campo contact_id es obligatorio."]
  }
}
```

**What does not exist in the account** answers like each domain: in conversations (contacts, messages, tags, fields, forms) `404 {"message": "Objeto no encontrado."}`, without `error`; in accounts (numbers) `404 {"message": "Object not found"}`; in communities (a group by its uid) Laravel's `404 {"message": "No query results for model [App\\Modules\\Shared\\Models\\Group] <uid>"}`. **What is in another workspace** answers `404` too: `{"message": ""}` in conversations, `{"message": "Not Found"}` for a number, the same `404` as one that does not exist for links, subscriptions and groups.

The complete spec the sandbox uses is at `GET /_sandbox/openapi.json`.

### With state or shape only

The sandbox answers every operation of that spec, in one of two ways:

- **With state**, the first use: numbers and sign-up links, contacts with their tags and fields, conversations and messages, groups (the live list, the list, one group, the import and the send), WhatsApp forms, mark as read and «typing…», and webhook subscriptions. What you create stays (in memory) and the events go out, signed.
- **Shape only**, everything else. The request is validated like any other (the key, the route, the path, the query and the body, with the same `401`, `404` and `422`), and the answer is the success status the spec gives (`200`, `201`, `202` or `204`) with a body that fits its response schema: the spec's example of the response when it has one that fits, otherwise one built from the schema. It is the same on every call to that operation, whatever you send. Nothing is stored and no event goes out: creating a board answers `201` with a board, and the list of boards does not have it.

A shape-only answer carries `X-Sandbox-Simulated: shape-only`; the body stays as the schema says. Nothing else carries that header.

```bash
curl -si -X POST http://localhost:4010/api/v1/kanban-settings -H "Authorization: Bearer $FUNNELCHAT_API_KEY" \
  -H 'Content-Type: application/json' -d '{"name": "Ventas", "mode": "stages"}'
# HTTP/1.1 201 Created
# X-Sandbox-Simulated: shape-only
# {"id": 1, "user_id": 1, "name": "Ejemplo", "mode": "ejemplo", …}
```

**To see which is which**, `GET /_sandbox/operations` lists every operation of the spec with `simulated`: `stateful`, `shape-only`, or `closed` (with `--no-group-actions`, the send to a group and its action, which answer `403 route_not_available`). A shape-only one also says its `status`, where its body comes from (`body_from`: `example`, `schema` or `none`) and whether it fits the schema (`body_fits_schema`). The list comes from the spec and the sandbox's handlers, so it follows the spec when it is regenerated.

```bash
curl -s http://localhost:4010/_sandbox/operations | jq '.meta'
# {"total": 253, "stateful": 88, "shape_only": 165, "closed": 0}
curl -s http://localhost:4010/_sandbox/operations | jq -r '.data[] | select(.simulated == "shape-only") | "\(.method) \(.path)"'
```

The panel (`/_sandbox`) counts them and marks each shape-only call of **Last requests** as **shape only**; `GET /_sandbox/requests` says `"simulated": "shape-only"` on those.

**How the body is built** when the spec has no example (the current one has none): for each schema, its `example`, `const`, `default` or first `enum` value when it fits; otherwise a plausible value of its type within the schema's limits (date, email, URL and UUID formats, lengths, bounds, number of items, `pattern`). `anyOf` and `oneOf` take the first branch whose value fits, and a list of the same schema it is inside of (a folder's folders, an action's sub-actions) stays empty. If a body ever did not fit (a schema asking for something the builder cannot make), the console says which operation, once, and `body_fits_schema` is `false`.

## Sending a message

**By phone, without `contact_id`** (conversations v1.19.21): `POST /api/v1/message/send-message` and `POST /api/v1/devices/{device}/templates/{template}/send-template` take `phone` instead of `contact_id`. The contact of that phone is found, or created in the key's workspace (with the `422`s of `update-or-create` for a phone that is not one), and the answer's `message.contact_id` says which. The contact stays created even if a rule (the window, the brakes, the MAC, a disconnected number) then stops the send. A phone of a contact of another workspace answers `404` and creates nothing. `whatsapp_id` (Meta's BSUID, `US.13491208655302741918`) works instead of `phone` only with an official number; with a QR number, together with `phone` or without the shape of a BSUID, it is a `422` on `whatsapp_id`. With `contact_id`, a `phone` or `whatsapp_id` in the body must be that contact's: `422 recipient_mismatch`, on `send-message` too.

```bash
curl -s http://localhost:4010/api/v1/contacts/2001/message \
  -H 'Authorization: Bearer 1|fc_live_sandbox' -H 'Content-Type: application/json' \
  -d '{"device_id": 4, "contact_id": 2001, "phone": "5491100000000", "text": "¡Hola!", "client_reference": "pedido-8841"}'
```

```json
{
  "message": {
    "id": 9001,
    "contact_id": 2001,
    "device_id": 4,
    "direction": "outbound",
    "type": "text",
    "status": "queued",
    "error": null,
    "client_reference": "pedido-8841",
    "created_at": "2026-10-22T12:00:00Z",
    "updated_at": "2026-10-22T12:00:00Z"
  }
}
```

- **Queued is not sent.** Then, at 1, 3 and 6 seconds (configurable), the message moves to `sent`, `delivered` and `read`, and every change arrives through `message.status_changed` with the same `message_id`, `previous_status` (`null` on the first one) and your `client_reference`. `queued` never appears in the event.
- The current status is read with `GET /api/v1/contacts/{contact}/messages/{message}` (the same object) and in the history `GET /api/v1/contacts/{contactId}/messages`.
- **A template created in Meta that does not appear in `GET /api/v1/templates`:** bring it with `POST /api/v1/devices/{device}/templates` (official numbers only, conversations v1.19.37) and list again. In the sandbox nothing goes to Meta: an official number answers `202 {"status": "completed"}`, a QR one `422 number_not_connected_to_meta`, and a number that is not of the key's workspace `404`.
- The same goes for `POST /api/v1/message/send-message` (`{message}`), templates (`POST /api/v1/devices/{device}/templates/{template}/send-template`, `{message}`), forms (`POST /api/v1/contacts/{contact}/message/form`, `{message}`), cards (`{messages: [...]}`, one per card) and the forward (one item per destination, with its `message`, or `status: "blocked"` and `message: null`).
- `client_reference` is optional: 1 to 64 visible ASCII characters, no spaces. If it does not fit, `422 errors.client_reference`.
- A note (`"note": true`) is stored with `status: null` and is not sent.
- The `id` of each event is the same for the same message and the same status: deduplicate by `id`.

### A file by URL

On `POST /contacts/{contact}/message` and `POST /message/send-message`, `file` is an `http(s)` URL (also signed, or without an extension) or a file name. The type comes from the extension, as in conversations: `jpg`, `jpeg` and `png` are `image`; `webp`, `sticker`; `gif` and `mp4`, `video`; `ogg`, `oga`, `mp3`, `aac`, `m4a`, `opus` and `wav`, `audio`; `pdf`, `doc` and `docx`, `document`. It looks at the extension of the URL's path and, if that one does not work, at the one of the whole URL (a signed URL that ends in `.pdf`).

| Case | Answer |
|---|---|
| The URL does not say its format and you sent no `file_type` | `422 errors.file_type`: «Tu archivo viene de una URL que no indica su formato: envía file_type con uno de estos valores: image, video, audio, document o sticker.» |
| `file_type: "document"`, the URL does not end in an accepted extension and `file_name` with an extension is missing | `422 errors.file_name`: «Para enviar un documento desde una URL que no termina en una de las extensiones admitidas, envía file_name con su extensión, por ejemplo factura.pdf.» |
| `file` malformed or longer than 4096 characters | `422 errors.file` |
| A known but not accepted extension (`.zip`) without `file_type` | `415`: `{"error": "Unsupported file type: zip", "supported_file_types": [...]}`; on `send-message`, `{"status": "error", "error": "Unsupported file type: zip"}` |

`file_type` (`image`, `video`, `audio`, `document` or `sticker`) always wins over the extension. The sandbox does not download the file.

### The rules

They apply to every send with a key, in this order, as in the API. The first one that refuses wins; nothing is stored and nothing is sent.

| Rule | Answer | When |
|---|---|---|
| Number without connection | `422 device_unavailable` | After `POST /_sandbox/devices/{id}/disconnect`. |
| Recipient | `422 recipient_mismatch` | On `contacts/{contact}/message` and on templates: the body's `phone` or `whatsapp_id` is not the one of the route's contact. |
| Recipient | `422 recipient_unsupported` | The contact is a group, a list or a channel (`whatsapp_id` with `@g.us`, `@broadcast`…). |
| Pace | `429 rate_limited` with `Retry-After` | Official number: more than 60 messages per second (`Retry-After: 1`), or more than 10 to the same contact in the same clock minute (`Retry-After`: what is left of the minute). A QR number has no limit. |
| 24-hour window | `422 window_closed` | Official number, free text (not a template) and the contact did not write in the last 24 hours. |
| Spam brakes | `422 antiblock_duplicate_content` | The third send of the same content to a contact who did not answer. |
| Spam brakes | `422 antiblock_unanswered_limit` | The sixth send in a row to a contact who did not answer. |
| MAC | `429 mac_lockout_24h`, without `Retry-After` | The account is in the 24-hour lockout and the contact is not active in the cycle, or the contact is inactive by MAC (`POST /_sandbox/mac`). Templates do not have this brake; in a forward, that destination comes back `blocked` with `reason: "mac_lockout_24h"`. |

An incoming message from the contact opens the window of that number and resets the brakes. The error messages are the API's. To turn a rule off: `--no-window`, `--no-antiblock`, `--no-rate-limit`.

Some routes have bodies of their own, as in conversations: `send-message` answers `404 {"status": "error", "error": "Contacto no encontrado."}` and `403 {"status": "error", "error": "No autorizado"}`; a template that does not exist is `404 template_not_found`, one of another number `422 {"error": "La plantilla no pertenece al número actual", "error_code": "template_waba_mismatch"}`, and one with unfilled variables `422 template_unresolved_placeholder` with `placeholders` and `count`.

### Forcing failures

**Make the send answer an error** (`reject`), with any code of the table above, `not_sent`, `recipient_unreachable` or `mac_limit_reached`:

```bash
curl … -H 'X-Sandbox-Reject: rate_limited'   # 429 with Retry-After: 6
```

**Make the send be accepted and end `failed`** (`fail`):

| Value | What arrives |
|---|---|
| A reason of Funnelchat: `window_closed`, `insufficient_balance`, `device_unavailable`, `recipient_unreachable`, `template_not_found`, `template_unresolved_placeholder`, `not_queued`, `not_sent` | A single `failed` with `previous_status: null` and `error: {code: null, title: <the API's text>, reason: <reason>}`. |
| A code of Meta, for example `131047`, `131026`, `131049` | `sent` and then `failed` with `error: {code: 131047, title: "Re-engagement message", reason: null}`. |

```bash
curl … -H 'X-Sandbox-Fail: window_closed'
```

**Make the API edge fail** (`edge`), on any `/api/v1` route:

| `X-Sandbox-Edge` | What happens |
|---|---|
| `origin_unreachable` | `502 {"error": "origin_unreachable", "message": "La API no está disponible en este momento."}`. The request never arrived: nothing was applied. |
| `origin_unreachable_applied` | The same `502`, but the write **was** applied and only the answer was lost. This is how you test the portal's rule: a `502` on a write is treated as a timeout, and the state is read before repeating it. |
| `edge_misconfigured` | `500 {"error": "edge_misconfigured", "message": "La API no está disponible en este momento."}` |

None of them carries `Retry-After`.

If you cannot send headers (from n8n, for example), arm the next failures beforehand:

```bash
curl -s http://localhost:4010/_sandbox/failures -H 'Content-Type: application/json' \
  -d '{"mode": "fail", "code": "131047", "count": 1, "contact_id": 2001}'
curl -s http://localhost:4010/_sandbox/failures -H 'Content-Type: application/json' \
  -d '{"mode": "edge", "code": "origin_unreachable", "applied": true, "count": 1}'
```

`GET /_sandbox/failures` lists the armed ones, `GET /_sandbox/failures/codes` the codes each mode takes and `DELETE /_sandbox/failures` deletes them. You can also move a message by hand: `POST /_sandbox/messages/{id}/status` with `{"status": "delivered"}` (or `"failed"` with `"error": "131026"`); it never goes back.

## WhatsApp forms

The routes of conversations, with state. A form is a family (`family_id`, the one you send) with versions (`id`, the one you edit). Only official numbers take them: with the QR one, `422 NUMBER_NOT_ELIGIBLE`.

| Route | What it does |
|---|---|
| `GET /api/v1/forms/templates` | The five templates to start from: `blank`, `lead`, `appointment`, `nps`, `signup`. |
| `POST /api/v1/forms` | `{"device_id": 3, "template_key": "lead"}` (optional `device_ids`): a draft. `201` with `data`, `lint` and `numbers`. |
| `GET /api/v1/forms`, `GET /api/v1/forms/{id}` | The list (one row per form, with `sends` and `responses`) and one version with `lint`, `versions` and `numbers`. |
| `PUT /api/v1/forms/{id}` | Saves `definition` (and, optionally, `name`). Published: `409 PUBLISHED`. |
| `DELETE /api/v1/forms/{id}` | A draft (`204`). Published: `409 PUBLISHED`. |
| `POST /api/v1/forms/{id}/sync`, `…/publish` | Runs the linter and publishes. With errors, `422 LINT` with the list. The other numbers go through `publishing` and end `published`. |
| `POST /api/v1/forms/{id}/versions` | A new draft version (`201`), or `200` with `created: false` if there was one already. |
| `GET`, `POST /api/v1/forms/{id}/numbers`, `DELETE …/numbers/{deviceId}`, `POST …/numbers/retry` | The numbers of the form. The primary one cannot be removed: `422 PRIMARY_NUMBER`. |
| `GET /api/v1/forms/families/{familyId}/definition`, `…/versions`, `…/responses`, `…/responses/{runId}` | The current definition, the versions and the responses. |
| `POST /api/v1/contacts/{contact}/message/form` | `{"form_id": <family_id>, "device_id": 3}` (optional `text`, `button_text`, `client_reference`): `200` with the queued message, `type: "whatsapp_form"`. |

The send follows the order of conversations: `device_unavailable`, `404 form_not_found`, `422 number_not_eligible`, `422 form_not_published`, `422 form_not_on_number`, `422 recipient_unreachable`, `422 window_closed`, and then the pace, the brakes and the MAC. An incoming message opens the window.

**Make the contact complete it:**

```bash
curl -s http://localhost:4010/_sandbox/forms/complete -H 'Content-Type: application/json' \
  -d '{"message_id": 9002, "answers": {"nombre": "Ana", "volumen": "op_mas_de_quinientos"}}'
```

It emits `whatsapp_form.completed` once per send, with `form` (`id` is the `family_id`, `version_id` the version sent), `message_id`, `contact_id`, `device_id` and `answers` (`{key, label, value}`, one per question, in order). What you do not send in `answers` takes an example value; options go by their id. `run_id` also works, or `contact_id` (the last pending send to that contact).

## Connecting numbers

Create and connect WhatsApp numbers through the API: a number by QR, or a sign-up link your customer opens. It is in
production in accounts since 25-10; the sandbox follows the contract of 22-10, its amendments v0.1 and v0.2 of 23-10
and the changes of 25-10 (the QR every 5 seconds, `country`), checked against accounts v1.5.97 (see
[Pending of the spec](#pending-of-the-spec)). A number, a link and the number a link creates belong to the workspace
of the key that created them.

**The official sign-up (`type: meta`) is not available in production yet:** it stays off until the domain is
registered with Meta, and `POST /api/v1/connect-links` with `type: meta` answers `503 meta_connect_disabled`. The sandbox
starts the same way. To test it, turn it on with `--meta-connect`, `"numbers": {"metaConnect": true}` in the file, or
`POST /_sandbox/numbers {"meta_connect": true}` while it runs.

| Route | What it does |
|---|---|
| `POST /api/v1/devices` | A number by QR: `{"connection": "qr"}`, optional `alias`, `external_reference`, `same_number_as` and `country` (two letters, any case: the country of the phone, where the WhatsApp session is opened from). `201 {"data": <number>}` with `connected: 0` and no phone yet. |
| `GET /api/v1/devices/{device}/qr` | `{"data": {"connected", "qr_code", "expires_in"}}`: a PNG as a data URI, `null` and `expires_in: 0` once connected, with `Cache-Control: no-store`. `expires_in` is `5`: ask for the QR every 5 seconds and show the new one at once, since WhatsApp changes the code and an old one does not link. It is fake: nothing scans it. An official number answers `422 provider_unsupported`. |
| `GET /api/v1/devices?external_reference=…` | Only the numbers with exactly that reference. `PUT /api/v1/devices/{device}` changes it (`null` clears it). |
| `DELETE /api/v1/devices/{device}` | `200` with an empty body: deletes it, frees its place and emits `device.deleted`. |
| `POST /api/v1/connect-links` | A sign-up link, `201 {"data": <link>}` with `Cache-Control: no-store`. The `url` with the token is only in this answer. |
| `GET /api/v1/connect-links`, `GET …/{link}` | The links without their token, newest first, paginated, filtered by `status` and `external_reference`. The `id` is an integer. `status`: `pending`, `completed`, `failed`, `expired` (`error_code: link_expired`) or `revoked` (`error_code: revoked`). |
| `DELETE /api/v1/connect-links/{link}` | Revokes a `pending` link: `204`, `409 link_not_pending` otherwise, `404` if it does not exist. |

**The body of a link**, by `type`:

| Field | `type: qr` | `type: meta` |
|---|---|---|
| `allowed_connection_types` | prohibited | required: `coexistence`, `dedicated` or both, without repeating |
| `provision_us_number` | prohibited (even `false`) | optional: a US number of the pool (3 per account, 1 on trial accounts). With `true`, `allowed_connection_types` must include `dedicated` and `device_id` is not allowed: a pool number is always dedicated, and new |
| `same_number_as` | optional, not with `device_id`: QR on a number in coexistence | prohibited |
| `country` | optional, not with `device_id`: two letters, the country of the phone; the link returns it in lower case | prohibited |
| `device_id` | optional: reconnects that number (`422 connection_type_mismatch` if it is not QR) | the same, for an official number |
| `external_reference` | optional, up to 255 | optional, up to 255 |
| `return_url` | optional, `https`, up to 2048 | the same |
| `expires_in_minutes` | 30 to 10080, 1440 by default | the same |

`null` counts as missing, like Laravel's `prohibited`. A broken rule answers
`422 {"error": "invalid_request", "message": "…", "errors": {"field": ["…"]}}`, and so does `POST /devices`. A
`device_id` or `same_number_as` that is not a number of the account answers `422 invalid_reference_device`.

**Each number has** `external_reference` (your text, not unique) and `connection` (`qr`, `coexistence` or
`dedicated`). The four `device.*` events carry both inside `device`, and `connect_link_id`: in `device.connected`, the
link of that connection; in the other three, the link that connected the number last; `null` without one. `device.disconnected` brings `reason`: `qr_logged_out`, `meta_account_not_registered`,
`shadow_ban_protection`, `provider_error`, `unknown` or `disconnected_by_user`. Like every event, they end with
`workspace_id`, the number's workspace.

**The quota** counts phones: QR and Meta of the same phone count once. The sandbox account allows 5 and the two
example numbers use two; change it with `POST /_sandbox/numbers`. The rejections:

- `403 numbers_not_included`, and `403 number_limit_reached` with `limit`, `used` and `pending_device_ids`;
- `409 pending_number_exists` with `device_id`: there is already a QR number not connected yet, so connect it or
  delete it first;
- `422 qr_requires_coexistence` (QR on an official number that is not in coexistence) and
  `422 method_already_present` (with `device_id`).

A reconnection, and QR on a number in coexistence, take no place. Up to 20 open links (`429 too_many_open_links`)
and 10 creations per minute (Laravel's `429 {"message": "Too Many Attempts."}`, with `Retry-After`). While the Meta
sign-up is off (the default), a `meta` link answers `503 meta_connect_disabled`, and so does the page of a `meta` link
made while it was on.

**`Idempotency-Key`** works on both `POST`, per resource: the same key with the same body gives back the same `2xx`
with `Idempotent-Replayed: true`, without creating anything; with another body, `422 idempotency_key_mismatch`; a
malformed key (empty, over 255 or with spaces), `422 invalid_idempotency_key`. A rejection is not kept: fix it and
retry with the same key.

A number by QR, its code and the scan (the scan is a sandbox route):

```bash
KEY='Authorization: Bearer 1|fc_live_sandbox'
curl -s -X POST localhost:4010/api/v1/devices -H "$KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: alta-cliente-8841' -d '{"connection": "qr", "external_reference": "cliente-8841"}'
curl -s localhost:4010/api/v1/devices/5/qr -H "$KEY"          # {"data": {"connected": false, "qr_code": "data:image/png;base64,…", "expires_in": 5}}
curl -s -X POST localhost:4010/_sandbox/devices/5/connect      # device.connected
```

A sign-up link and its page (`meta` links need the Meta sign-up on: `npx funnelchat-sandbox --meta-connect`):

```bash
curl -s -X POST localhost:4010/api/v1/connect-links -H "$KEY" -H 'Content-Type: application/json' \
  -d '{"type": "meta", "allowed_connection_types": ["coexistence", "dedicated"], "external_reference": "cliente-8841", "return_url": "https://your-app.example/connected"}'
# {"data": {"id": 1, "type": "meta", "status": "pending", "url": "http://localhost:4010/connect/<token>", …}}
curl -si -X POST 'http://localhost:4010/connect/<token>/start' -d connection=coexistence
# 303 Location: https://your-app.example/connected?connect_link_id=1&status=completed&device_id=6
```

**The page** is a test page. Opening `GET /connect/{token}` does not use the link, as in production, so a
messenger's preview cannot burn it: it shows a button (and, for a `meta` link that allows both, the choice of
connection) and takes the token out of the address bar (`/connect/reopen`). The button, `POST /connect/{token}/start`,
connects at once: it creates the number (or reconnects it), marks the link `completed`, emits `device.connected` and
redirects to `return_url` with `connect_link_id`, `status`, `device_id` (if it completed) and `error_code` (if it
failed), or says it on the page. `POST /connect/{token}/complete` does the same. A link works once; then the page
answers `410`.

Two answers of the page do not end the link. A `connection` the link does not allow answers
`422 connection_type_not_allowed`. A failure of Facebook or Meta on a `meta` link (`error_code=facebook_auth_failed`
or `meta_error`) leaves it `pending` so your customer retries: `{"state": "retry", "error_code": "…", "attempts_left": 3}`
when you send JSON, the page with the button again otherwise; the fifth failure ends it `failed`. `quota_exceeded`,
`trial_number_blocked`, `number_not_owned` and the QR's `qr_timeout` end it at the first. In the body (form or JSON) or the query you choose what happens: `outcome=failed` with `error_code`
(`qr_timeout` or `meta_error` by default), `connection` when the link allows both, and `number`. With `Authorization`
or `X-Api-Key` it answers `403 credentials_not_allowed`. Its headers are production's: `Cache-Control: no-store, private`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Robots-Tag: noindex`, HSTS, COOP and a CSP with a nonce.

With the Node SDK, once it has the new methods:

```ts
const device = await funnelchat.devices.create({ connection: 'qr', external_reference: 'cliente-8841' });
const { qr_code } = await funnelchat.devices.qr(device.id);
const link = await funnelchat.connectLinks.create({ type: 'qr', return_url: 'https://your-app.example/connected' });
await fetch(`${link.url}/start`, { method: 'POST', redirect: 'manual' }); // the button of the sandbox page
```

## Webhooks

You subscribe with the same routes the SDKs and the n8n trigger use (the unified subscriptions of accounts):

| Route | What it does |
|---|---|
| `POST /api/v1/webhooks` | Creates a subscription. The answer (`201`) carries `secret` **only once**. |
| `GET /api/v1/webhooks`, `GET /api/v1/webhooks/{id}` | Lists or shows them, without the secret. |
| `PUT /api/v1/webhooks/{id}` | Changes `url`, `events`, `description`, `filters` and, optionally, `status` (`active` or `paused`). The secret does not change. |
| `DELETE /api/v1/webhooks/{id}` | Deletes it (`204`). |
| `POST /api/v1/webhooks/{id}/test` | Sends a signed `webhook.test` now and answers `{succeeded, response_status, error, duration_ms, delivery_id}`. |
| `GET /api/v1/webhooks/{id}/deliveries` | The history: one record per attempt, newest first. |
| `GET /api/v1/webhooks/events` | The event catalog of the spec: the 55 types of the `events` enum of `POST /api/v1/webhooks` and `webhook.test` (not subscribable), all `active`, each with `area`, `status`, `description`, `subscribable` and `example`. |

**Each delivery** is a `POST` with the portal's envelope and these headers:

```
Content-Type: application/json
X-Funnelchat-Signature: t=1792152000,v1=5f0c…
X-Funnelchat-Event: message.received
X-Funnelchat-Delivery: 7c9e6679-7425-40de-944b-e07fc1f90ae7
```

```json
{
  "id": "evt_6f1c2a9b0d3e4f5a6b7c8d9e",
  "type": "message.received",
  "version": 1,
  "occurred_at": "2026-10-22T12:00:00Z",
  "data": {
    "message": { "id": 9002, "type": "text", "text": "Hola, quiero más información", "media": null },
    "contact": { "id": 2001, "name": "Contacto de ejemplo", "phone": "+5491100000000" },
    "receiver": { "phone": "+5491100000001" },
    "device_id": 3,
    "workspace_id": 1
  }
}
```

- **`data.workspace_id`** is in every event, the last key of `data`: the workspace the event belongs to (the number's, the contact's or the group's). A subscription belongs to the workspace of the key that created it and only gets that workspace's events; `webhook.test` carries the subscription's.
- **The signature** is the portal's: `v1` is the HMAC-SHA256, with the full secret (with `whsec_`), of `"<t>." + raw body`. Verify it with `Funnelchat.webhooks.verify` (Node), `Webhook::verify` (PHP) or the portal's snippets. The sandbox's tests verify it with the Node SDK's `verify` and with the portal's `verificar-firma.js`, on the vectors of `tests/test_firmas.py`.
- **The retries** are the portal's: up to 4 attempts, waiting 60 s, 300 s and 1800 s (shorten them with `--retry-delays`). A network error, a timeout (10 s), a `5xx` or a `429` is retried; any other `4xx` or a `3xx` is final. Every attempt carries the same body and the same `id`, a new signature and another `X-Funnelchat-Delivery`.
- **Five failed deliveries in a row** disable the subscription (`status: disabled`, `disabled_reason: too_many_failures`), as in accounts. A `PUT` with `"status": "active"` turns it back on.
- The sandbox accepts `http` and local URLs, so you can point at your machine. The real API only accepts public `https`: try it with `--require-https`.
- **The events the sandbox emits on its own** are those of its state: `message.received`, `message.status_changed`, `whatsapp_form.completed`, `contact.*`, `conversation.*`, `template.status_changed`, `device.*` and the ones you fire from `/_sandbox`. Any other type of the catalog is emitted with `POST /_sandbox/events/{type}`.

## Simulating what comes in

These routes take no key: they belong to the sandbox, not to the API.

| Route | What it simulates |
|---|---|
| `POST /_sandbox/inbound/message` | A contact writes to you: `{"phone": "5491100000000", "device_id": 3, "text": "Hola"}` (or `contact_id`; optional `name`, `type`, `file` and `occurred_at`). If the phone is new it creates the contact (`contact.created`); then it emits `message.received` and opens the 24-hour window of that number. |
| `POST /_sandbox/groups`, `GET /_sandbox/groups` | A group of a connected QR number, in the number's workspace: `{"device_id": 5, "name": "Clientes", "participants": [{"phone": "5491155550000", "name": "Ana"}]}`. In the account unless `"imported": false` (only on WhatsApp, to import); the number is its admin unless `"admin": false`. |
| `POST /_sandbox/groups/participant-joined`, `…/participant-left` | Someone joins or leaves a group: `{"group_id": 7001, "participant": {"phone": "…", "name": "…"}}` (or `"uid"`; the example group without either). The group's participants change and the event goes to its workspace. A `group` the sandbox does not have (`{"group": {"uid": "…@g.us", "name": "…"}}`) goes out from the catalog's example. |
| `POST /_sandbox/forms/complete` | The contact completes a sent form: emits `whatsapp_form.completed` (see [WhatsApp forms](#whatsapp-forms)). |
| `POST /_sandbox/mac`, `GET /_sandbox/mac` | The account's MAC: `{"lockout": true, "active_contact_ids": [2001], "inactive_contact_ids": []}`. With `lockout`, sends to contacts that are not active answer `429 mac_lockout_24h`; an inactive contact always gets it. |
| `POST /_sandbox/contacts/{id}/tags` with `{"tag_id": 4001}`, `DELETE /_sandbox/contacts/{id}/tags/{tag}` | Someone tags the contact in the panel: `contact.tag_added` and `contact.tag_removed`. |
| `POST /_sandbox/devices/{id}/disconnect`, `…/connect` | The number disconnects (`{"reason": "disconnected_by_user"}`, any of the list; `qr_logged_out` for QR and `unknown` for official ones by default) or connects, which is the scan of a QR (`{"number": "5491155550101"}`, a fake one otherwise): `device.disconnected` and `device.connected`. Disconnected, sends answer `422 device_unavailable`. |
| `POST /_sandbox/devices/{id}/health` | The health of an official number changes: `{"state": "limited"}` (`available`, `limited`, `blocked`, `unknown`) emits `device.health_changed`, only if it changed. |
| `POST /_sandbox/numbers`, `GET /_sandbox/numbers` | The quota of the account: `{"limit": 3, "included": true, "trial": false, "meta_connect": true, "links_per_minute": 10}` (`meta_connect` turns the Meta sign-up on or off). `GET` also says how many places are in use and which QR numbers are pending. |
| `POST /_sandbox/templates/{id}/status` | Meta approves or rejects a template: `{"status": "REJECTED", "reason": "…"}` emits `template.status_changed`. |
| `POST /_sandbox/events/{type}` | Any event of the catalog, with its example; what you send in `{"data": {…}}` overrides it, and `{"workspace_id": 2}` sends it to that workspace (the default one otherwise). `GET /_sandbox/events` lists them. The example is the one of the catalog, the spec's. |
| `POST /_sandbox/window` | Opens or closes the window by hand: `{"contact_id": 2001, "device_id": 3, "open": false}`. |
| `POST /_sandbox/workspaces`, `GET /_sandbox/workspaces` | A [workspace](#workspaces) with a key that only sees it: `{"name": "Cliente B"}` answers `201 {workspace, key}`. `POST /_sandbox/keys` with `{"workspace_id": 2}` mints another key (of the default workspace without `workspace_id`); with `"permissions": [...]` it has only those (the sandbox checks just `communities:operate`, to import a group). |
| `POST /_sandbox/reset` | Back to the initial state. |
| `GET /_sandbox/state`, `/_sandbox/requests`, `/_sandbox/deliveries`, `/_sandbox/emitted` | The state, the last requests (`simulated: "shape-only"` on the ones answered [shape only](#with-state-or-shape-only)), the last deliveries with what your server answered, and every event emitted, delivered or not (with how many subscriptions got it). |
| `GET /_sandbox/operations` | Every operation of the spec and how the sandbox answers it: `stateful`, `shape-only` or `closed`. See [With state or shape only](#with-state-or-shape-only). |

Besides, as in the API: creating a contact emits `contact.created`, closing a conversation (`active_conversation: false`) emits `conversation.closed`, assigning it emits `conversation.assigned`, and a template created through the API goes from `PENDING` to `APPROVED` after 5 seconds with `template.status_changed`.

**The panel** is at `http://localhost:4010/_sandbox`: the numbers (with **Scan the QR** for one waiting for it), every event emitted, the last requests (the ones answered shape only, marked **shape only**), the webhook deliveries with your server's answer, and a form to send an incoming message.

## End to end

An Express receiver that verifies the signature with the SDK, a subscription, an incoming message and the answer with its statuses.

```bash
npx @funnelchat-hq/sandbox --status-delays 1,1,1
```

```ts
// receiver.ts
import express from 'express';
import { Funnelchat, WebhookVerificationError } from '@funnelchat-hq/sdk';

const funnelchat = new Funnelchat({ apiKey: '1|fc_live_sandbox', baseUrl: 'http://localhost:4010' });
const app = express();
let secret = '';

app.post('/hooks/funnelchat', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = Funnelchat.webhooks.constructEvent(req.body, req.get('X-Funnelchat-Signature'), secret);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.sendStatus(400);
    throw error;
  }
  res.sendStatus(200);

  if (event.type === 'message.received') {
    // Answer through the same number: on the official one, the window is already open.
    const { message } = await funnelchat.messages.send(event.data.contact.id, {
      device_id: event.data.device_id!,
      phone: event.data.contact.phone!.replace('+', ''),
      text: '¡Gracias por escribirnos!',
      client_reference: `respuesta-${event.data.message.id}`,
    });
    console.log('sent', message.id, message.status); // queued
  }
  if (event.type === 'message.status_changed') {
    console.log('status', event.data.message_id, event.data.status, event.data.client_reference);
  }
});

app.listen(3000, async () => {
  const subscription = await funnelchat.webhooks.create({
    url: 'http://localhost:3000/hooks/funnelchat',
    events: ['message.received', 'message.status_changed'],
  });
  secret = subscription.secret; // shown only once
  console.log('subscription', subscription.id);
});
```

```bash
# A contact writes to your official number:
curl -s http://localhost:4010/_sandbox/inbound/message -H 'Content-Type: application/json' \
  -d '{"phone": "5491100000000", "device_id": 3, "text": "Hola, ¿tienen stock?"}'
```

On the receiver's console:

```
sent 9002 queued
status 9002 sent respuesta-9001
status 9002 delivered respuesta-9001
status 9002 read respuesta-9001
```

And at `http://localhost:4010/_sandbox` you see each request and each delivery with what your receiver answered.

## What it does not imitate

- **It sends nothing to WhatsApp** and charges nothing: the `sent`, `delivered` and `read` statuses are made up by the sandbox, with the delays you configure. In the real API, a message still `queued` after an hour reads as `status: null`; in the sandbox it always moves on.
- **One account and every permission:** any well-formed key gets in, is never revoked and there is no `403 permission_denied`. Workspaces are created and their keys minted through `/_sandbox`, never deleted, and a number does not move between workspaces. API keys are not created here, and subscriptions are not filtered by the key's areas (the real API answers `422` on `events` if the key lacks the event's `{area}:read`). The only `403 route_not_available` is the send to a group with `--no-group-actions`.
- **There are no daily call caps** (`429 daily_cap_exceeded`), no `503 gate_unavailable` and no balance: to test those cases, force the failure. Of the MAC there is the lockout (`429 mac_lockout_24h`); `429 mac_limit_reached` is only forced, and the real API also stores in the history an error row for every send stopped by the MAC, which the sandbox does not.
- **The state is memory only:** it is lost when the process stops or with `POST /_sandbox/reset`. So your receiver does not lose the secret, put the subscription in the configuration file.
- **The shape-only routes** answer the shape of the spec, always the same: it does not match your data, a write keeps nothing and no event goes out. See [With state or shape only](#with-state-or-shape-only).
- **The validation messages** are Laravel's in Spanish, built from the schema: they may not match the API's word for word (decide by the HTTP status and by `error`, not by `message`). The real API's validation `422` is Laravel's, `{message, errors}`, without `error`; the sandbox adds `"error": "validation_failed"`.
- **Webhook URLs** may be `http` and local, without the real API's protection against internal destinations (try `--require-https`). Do not expose the sandbox to the internet: the `/_sandbox` routes take no key and the sandbox `POST`s to any URL subscribed to it.
- **The event catalog** is what the spec documents (`generated/catalog.json`, transcribed by `npm run generate`): fields of production's catalog the spec does not document, such as `is_critical` and `label`, are not there.
- **Groups have state only for the number's live list, the list, one group, the import and the send of a message** (the action is `completed` after the delays of `sent` and `delivered`; it never fails on its own). The live list is never cached (production keeps it a minute for a key). The other group actions, the campaigns and the rest of the groups' routes answer shape only, and their events are fired from `/_sandbox`. There are no official groups (the account is not in their beta), no `too_many_pending_actions` and no rate limit of 30 sends per minute.
- **Workspaces confine** numbers, sign-up links, webhook subscriptions, contacts, conversations, messages, templates and groups. Tags, custom fields and forms are not confined in the sandbox. A contact belongs to one workspace, and the phone stays unique in the account: `POST /api/v1/contacts`, `update-or-create` and a send by phone with a phone of another workspace answer `404`.
- **Forms do not talk to Meta:** `sync` and `publish` succeed unless the linter finds an error, and the linter is a short version of the real one (screens without a title, without an ending, without questions, with a connection to the server). The metrics (`…/metrics`) answer shape only, and there are no dynamic forms.
- **Files are not downloaded:** the type comes from the extension or from `file_type`. The «known» extensions (the ones that give `415` instead of `422 errors.file_type`) are the common ones; the API uses symfony/mime's full list.
- **Connecting numbers** follows a contract, not production: no real QR, no Meta Embedded Signup and no 15-minute hold of a pool number. The page has no `POST /connect/{token}/qr` (the button connects at once) and no `POST /connect/{token}/offer` (the pool number is given when the link completes). A QR link that fails does not create (and delete) a number, links do not die when a key is revoked, the per-minute limit counts only the calls that pass the schema, and `409 operation_in_progress` only appears if two calls with the same `Idempotency-Key` overlap. The errors that depend on the plan, the payment or the provider (`connect_not_allowed`, `number_suspended_by_plan`, `payment_required`, `device_inactive`, `provider_error`…) are documented but never answered.
- **Template metrics and the WhatsApp Business accounts** (`GET /api/v1/templates/{template}/metrics`, `GET /api/v1/me/whatsapp-business-accounts…`) answer shape only, not data of the sandbox. **Mark as read and «typing…»** have no per-second ceilings (`429 rate_limited`) and never fail at WhatsApp (`502 provider_error`).
- **The secret of a subscription is rotated from the panel:** `POST /api/v1/webhooks/{id}/rotate-secret` is not in the published spec, so here it is `404 route_not_found` (a key gets `403 route_not_available` in production).
- **Forms** are served here, but the API edge does not route `forms` yet: through the public URL they answer `404 route_not_found`.
- **The pace and the brakes** use the numbers of conversations in production (`config/send_guards.php`, `config/antiblock.php`); the official number paired with a QR one in coexistence (15 per second, shared) is not there.

## Pending of the spec

The spec (`spec/funnelchat.json`) is the one the portal publishes, v0.6.14 (https://developers-portal.funnelchat.app/specs/funnelchat.json, 13-11): only the operations and events the portal shows. **The sandbox offers only that:** a layer corrects shapes where the spec says otherwise than production answers, but never adds an operation or an event (the generator refuses it and says so). The corrections are in two layers, which the next regeneration drops on its own once the spec carries them:

- `spec/pending.json`: the pending layer of the Node SDK (`funnelchat-node` @ `bde8679`), with the corrections of 13-11 made here ahead of the SDK: `answers[].label` of `whatsapp_form.completed` is always a string, `message.type` of `message.received` accepts types the spec does not list yet, and its sources say what portal v0.6.14 shows (its note in `spec/procedencia.json` lists them). Guarded by JSON Pointer conditions: the send answers, `devices/{device}/qr`, the template list, `PUT webhooks/{id}`, `GET groups/actions/{action}`, and the shapes of the number, group, billing, form and message events.
- `spec/pending-sandbox.json`: what the sandbox corrects on top of it, with its sources inside.

The event catalog (`generated/catalog.json`) comes out of the merged spec, with the same command: see [Regenerating](#regenerating).

What `spec/pending-sandbox.json` still corrects:

| What | Why neither the spec nor the Node SDK's layer has it |
|---|---|
| `data.workspace_id` in every event (accounts v1.5.97, Q35) | The events of the spec do not carry it yet |
| `null` in `allowed_connection_types` and `provision_us_number` of `POST /api/v1/connect-links` | A correction: accounts' rules depend on `type`, and Laravel's `prohibited` lets `null` through |

## Regenerating

Everything generated comes from a single script:

```bash
# With a new spec of the portal: always the one it publishes, only the operations and events the portal shows (the
# tools are generated only from what the portal publishes). Download it, and say with --origin which version of the
# portal it is, for example {"url": "https://developers-portal.funnelchat.app/specs/funnelchat.json",
# "portal_version": "v0.6.14"}; it is the only place the version is written, and spec/procedencia.json keeps it:
curl -sO https://developers-portal.funnelchat.app/specs/funnelchat.json
npm run generate -- --spec funnelchat.json --origin <that JSON>

# With a new pending layer of the Node SDK (its spec/pending.json):
npm run generate -- --pending <the SDK's spec/pending.json>

# With what is already in spec/ (for example, after touching spec/pending-sandbox.json):
npm run generate

# To check that generated/ is up to date (useful in CI):
npm run generate:check
```

The event catalog comes out of the same command, so it is never transcribed by hand: the types are the `events` enum of `POST /api/v1/webhooks`, in its order, and each entry is what the spec documents for the type in `webhooks`, its example always the whole envelope (a correction that brings only `data` takes `id`, `version` and `occurred_at` from the portal's example); `webhook.test`, which only the test route sends, goes last and is not subscribable. A type of the enum that `webhooks` does not document stops the generation.

What it does:

1. With `--spec` or `--pending`, it copies the file to `spec/` and writes in `spec/procedencia.json` the repository, the branch, the commit, the date and the `sha256` (from git, or from `--origin` for what git cannot say).
2. It applies over the snapshot `spec/pending.json` and then `spec/pending-sandbox.json`, but **only what the snapshot lacks**, and never an operation or an event the snapshot does not carry: it refuses those and lists them. At the end it lists what the snapshot already carries, so you can delete it. An event a layer types without an example keeps the portal's example.
3. It writes `generated/openapi.json`, the spec the sandbox validates and answers with.
4. It writes `generated/catalog.json`, the event catalog, from that spec.

**A handler whose operation is not in the spec is not reached:** the route answers `404 route_not_found`, like a route the API does not have. After a regeneration, `GET /_sandbox/operations` says what has state and what answers [shape only](#with-state-or-shape-only).

**The current spec** is the one the portal publishes, v0.6.14, at https://developers-portal.funnelchat.app/specs/funnelchat.json (sha256 `37c54a5aad4cc467e088af50294012484692ef668714dcdd748babc7314b587f`, as served on 13-11): 209 paths, 253 operations and 57 events (56 types: the 55 of the `events` enum and `webhook.test`, which two areas document), in 30 groups: 1 of «Primer uso», 9 of «Funciones de WhatsApp» and 20 of «Funciones de Funnelchat». The detail is in `spec/procedencia.json`.

## Development

```bash
npm install
npm run generate:check   # generated/ is up to date
npm run typecheck        # tsc
npm run lint
npm test                 # vitest, no network: the receivers are local servers
npm run build            # dist/ in ESM, with .d.ts
```

The tests verify the deliveries with unchanged copies of the Node SDK's `verify` and of the portal's snippet (`test/vendor/`, with their provenance). If the `funnelchat-node` repo is next to this one (or in `FUNNELCHAT_NODE_SDK`), they also run against its current code, including the whole client pointed at the sandbox.

```
spec/            the spec, its provenance and the two pending layers
scripts/         generate.mjs, the only generator
generated/       the merged spec and the event catalog (not edited)
src/openapi/     routes, validation and the shape-only answers, from the spec
src/handlers/    the routes with state (numbers, links, contacts, messages, forms, groups, webhooks); index.ts is the table
src/forms/       the form templates
src/messaging/   send rules, the file by URL, forced failures and message statuses
src/webhooks/    signature, catalog, deliveries and retries
src/state/       the in-memory state, the public shapes and the workspaces
src/sandbox/     the /_sandbox routes and the panel
test/            vitest
```

**Publishing:** push a `vX.Y.Z` tag on `main` that matches the `version` in `package.json`; GitHub Actions publishes it through npm Trusted Publishing (`.github/workflows/publish.yml`).

## License

[MIT](LICENSE).
