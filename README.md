# @funnelchat-hq/sandbox

A local server that imitates the Funnelchat public API and sends signed webhooks, with no real effects. Use it to build and test your integration without a real account, without WhatsApp and without spending anything: nothing goes out to WhatsApp, everything stays in memory.

- The same routes, bodies and errors as the API in production (accounts v1.4.24, conversations v1.18.10, communities v2.34.52 and the API edge v0.3.0, since 21-10).
- In-memory state for a real flow: contacts, conversations and messages, tags, custom fields, templates, WhatsApp forms and webhook subscriptions.
- A send answers at once with the queued message, and then announces `sent`, `delivered` and `read` through `message.status_changed`.
- Webhooks signed with the portal's exact algorithm, with its retries, and the event catalog of production.
- The WhatsApp rules the API applies: the 24-hour window on official numbers, the per-number pace, the spam brakes and the MAC lockout.
- `X-Request-Id` on every response, like the API.

> **Status: v0.** The public API is in v0 and may change. What the sandbox does not imitate is in [What it does not imitate](#what-it-does-not-imitate).

**About the language.** This documentation, the command line, the panel and the sandbox's own routes (`/_sandbox`) are in English. The answers under `/api/v1` imitate the API, which answers in Spanish, so their messages are in Spanish, word for word where they come from the API's code. Decide by the HTTP status and by `error`, never by `message`.

## Starting it

You need Node 20.11 or later.

```bash
npx @funnelchat-hq/sandbox
```

Or, in your project, as a development dependency (the command it installs is `funnelchat-sandbox`):

```bash
npm install --save-dev @funnelchat-hq/sandbox
npx funnelchat-sandbox
```

```
funnelchat-sandbox 0.1.1 at http://127.0.0.1:4010
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
docker run --rm -p 4010:4010 funnelchat-sandbox
# with your configuration:
docker run --rm -p 4010:4010 -v "$PWD/funnelchat-sandbox.config.json:/app/funnelchat-sandbox.config.json:ro" funnelchat-sandbox
```

Inside the container it listens on `0.0.0.0`. If your webhook receiver runs on your machine, from the container it is `http://host.docker.internal:<port>` (on Linux, add `--add-host=host.docker.internal:host-gateway`).

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

The file also takes `numbers`, the quota of the account for [connecting numbers](#connecting-numbers): `{"limit": 5, "included": true, "trial": false, "metaConnect": true}`, and `publicUrl`.

There is a complete one in [funnelchat-sandbox.config.example.json](funnelchat-sandbox.config.example.json). The file `funnelchat-sandbox.config.json` is in `.gitignore`: do not commit a secret, even a test one.

## The key

Any key with the shape of a real one works: `Authorization: Bearer <id>|fc_live_<letters and digits>`, for example `1|fc_live_sandbox`. Without a key, or with a malformed one, it answers `401` like the API:

```json
{ "error": "unauthenticated", "message": "Falta la API key o no es válida." }
```

Every key sees the same account and has every permission.

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

`POST /_sandbox/reset` goes back to this and cancels everything that was scheduled.

**With state** (what you create, change or delete stays): contacts (`/api/v1/contacts…`, with their tags, fields and the `meta-window`), conversations (`/api/v1/conversations…`), messages (send, history, reactions, forward, cards and the lookup by id), tags, custom fields, templates, [WhatsApp forms](#whatsapp-forms), numbers and sign-up links ([connecting numbers](#connecting-numbers)) and webhook subscriptions with their history.

**The numbers** are those of accounts: `GET /api/v1/devices` always paginates (`{data, links, meta}`, `perPage` from 1 to 100), and each number carries `capabilities`, with what the API can do through it:

```json
{
  "messages": { "text": true, "media": true, "buttons": true, "lists": true, "templates": true, "location": true, "voice_note": true, "polls": false, "events": false, "contact_card": true, "reactions": false },
  "groups": { "create": false, "add_participants": false, "remove_participants": false, "admins": false, "photo": false, "settings": false, "invite_link": false, "send": false, "join_requests": false },
  "statuses": ["sent", "delivered", "read", "failed"]
}
```

The official number (`3`) has no groups (the sandbox account is not in the official groups beta); the QR one (`4`) does, and has no templates. `health` is `null` on the QR number.

**Polls and events** (`/message/poll`, `/message/event`) are closed to API keys in production: with any key they answer `403 route_not_available`, as they do here.

```json
{ "error": "route_not_available", "message": "Esta ruta no está disponible para API keys en el piloto. No es un permiso que falte: ninguna key la habilita." }
```

**Everything else** in the spec (broadcasts, flows, kanban, groups, campaigns, alerts…) answers an example built from the response schema: the spec's operations carry no examples of their own. The key, the route, the query and the body are still validated.

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

**What does not exist in the account** answers like each domain: in conversations (contacts, messages, tags, fields, forms) `404 {"message": "Objeto no encontrado."}`, without `error`; in accounts (numbers) `404 {"message": "Object not found"}`.

The complete spec the sandbox uses is at `GET /_sandbox/openapi.json`.

## Sending a message

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

Create and connect WhatsApp numbers through the API: a number by QR, or a sign-up link your customer opens. This is
**not in production yet**: the sandbox follows the contract of 22-10 while accounts builds it, and accounts' OpenAPI
will be the final word (see [Pending of the spec](#pending-of-the-spec)).

| Route | What it does |
|---|---|
| `POST /api/v1/devices` | A number by QR: `{"connection": "qr"}`, optional `alias`, `external_reference` and `same_number_as`. `201 {"data": <number>}` with `connected: 0` and no phone yet. |
| `GET /api/v1/devices/{device}/qr` | `{"data": {"connected", "qr_code", "expires_in"}}`: a PNG as a data URI (`null` once connected). It is fake: nothing scans it. An official number answers `422 provider_unsupported`. |
| `GET /api/v1/devices?external_reference=…` | Only the numbers with exactly that reference. `PUT /api/v1/devices/{device}` changes it (`null` clears it). |
| `DELETE /api/v1/devices/{device}` | Deletes it, frees its place and emits `device.deleted`. |
| `POST /api/v1/connect-links` | A sign-up link. `type` (`qr` or `meta`); with `meta`, `allowed_connection_types` (`coexistence`, `dedicated` or both) and `provision_us_number`; `device_id` to reconnect a number; `same_number_as` (`qr` only); `external_reference`; `return_url` (`https` only); `expires_in_minutes` (30 to 10080, 1440 by default). The `url` with the token is only in this answer. |
| `GET /api/v1/connect-links`, `GET …/{link}` | The links without their token, paginated, filtered by `status` and `external_reference`. `status`: `pending`, `completed`, `failed`, `expired` or `revoked`. |
| `DELETE /api/v1/connect-links/{link}` | Revokes a `pending` link: `204`, and `409 link_not_pending` otherwise. |

**Each number has** `external_reference` (your text, not unique) and `connection` (`qr`, `coexistence` or
`dedicated`). The four `device.*` events carry both inside `device`, and `device.connected` also brings
`connect_link_id`.

**The quota** counts phones: QR and Meta of the same phone count once. The sandbox account allows 5 and the two
example numbers use two; change it with `POST /_sandbox/numbers`. The rejections are `403 numbers_not_included`,
`403 number_limit_reached`, `422 qr_requires_coexistence` (QR on an official number that is not in coexistence) and
`422 method_already_present` (with `device_id`). A reconnection, and QR on a number in coexistence, take no place.
Up to 20 open links: one more answers `429 too_many_open_links`. With `"meta_connect": false`, a `meta` link answers
`503 meta_connect_disabled`, as production will while the Meta sign-up is off.

**`Idempotency-Key`** works on both `POST`: the same key with the same body gives back the same answer without
creating anything (only successful answers are kept); with another body, `422 idempotency_key_mismatch`.

A number by QR, its code and the scan (the scan is a sandbox route):

```bash
KEY='Authorization: Bearer 1|fc_live_sandbox'
curl -s -X POST localhost:4010/api/v1/devices -H "$KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: alta-cliente-8841' -d '{"connection": "qr", "external_reference": "cliente-8841"}'
curl -s localhost:4010/api/v1/devices/5/qr -H "$KEY"          # {"data": {"connected": false, "qr_code": "data:image/png;base64,…", "expires_in": 20}}
curl -s -X POST localhost:4010/_sandbox/devices/5/connect      # device.connected
```

A sign-up link and its page:

```bash
curl -s -X POST localhost:4010/api/v1/connect-links -H "$KEY" -H 'Content-Type: application/json' \
  -d '{"type": "meta", "allowed_connection_types": ["coexistence", "dedicated"], "external_reference": "cliente-8841", "return_url": "https://your-app.example/connected"}'
# {"data": {"id": "…", "status": "pending", "url": "http://localhost:4010/connect/<token>", …}}
curl -si 'http://localhost:4010/connect/<token>?connection=coexistence'
# 303 Location: https://your-app.example/connected?connect_link_id=…&status=completed&device_id=6
```

**The page `/connect/{token}`** is a test page that connects at once, on the first visit: it creates the number (or
reconnects it), marks the link `completed`, emits `device.connected` and redirects to `return_url` with the result,
or says it on the page. It works once; then it answers `410`. In the query (or in the body of
`POST /connect/{token}/complete`) you choose what happens: `outcome=failed` with `error_code` (`qr_timeout` or
`meta_error` by default), `connection` when the link allows both, and `number`. With `Authorization` or `X-Api-Key`
it answers `403`: the page never takes a key.

With the Node SDK, once it has the new methods:

```ts
const device = await funnelchat.devices.create({ connection: 'qr', external_reference: 'cliente-8841' });
const { qr_code } = await funnelchat.devices.qr(device.id);
const link = await funnelchat.connectLinks.create({ type: 'qr', return_url: 'https://your-app.example/connected' });
await fetch(link.url, { redirect: 'manual' }); // the sandbox page connects at once
```

## Webhooks

You subscribe with the same routes the SDKs and the n8n trigger use (the unified subscriptions of accounts):

| Route | What it does |
|---|---|
| `POST /api/v1/webhooks` | Creates a subscription. The answer (`201`) carries `secret` **only once**. |
| `GET /api/v1/webhooks`, `GET /api/v1/webhooks/{id}` | Lists or shows them, without the secret. |
| `PUT /api/v1/webhooks/{id}` | Changes `url`, `events`, `description`, `filters` and, optionally, `status` (`active` or `paused`). The secret does not change. |
| `DELETE /api/v1/webhooks/{id}` | Deletes it (`204`). |
| `POST /api/v1/webhooks/{id}/rotate-secret` | A new secret; the previous one stops working. |
| `POST /api/v1/webhooks/{id}/test` | Sends a signed `webhook.test` now and answers `{succeeded, response_status, error, duration_ms, delivery_id}`. |
| `GET /api/v1/webhooks/{id}/deliveries` | The history: one record per attempt, newest first. |
| `GET /api/v1/webhooks/events` | The catalog of accounts in production: 54 types (49 `active`), with `area`, `status`, `is_critical`, `label`, `description` and `example`. |

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
    "device_id": 3
  }
}
```

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
| `POST /_sandbox/groups/participant-joined`, `…/participant-left` | Someone joins or leaves a group: `{"group": {"uid": "…@g.us", "name": "…"}, "participant": {"phone": "…", "name": "…"}}`. |
| `POST /_sandbox/forms/complete` | The contact completes a sent form: emits `whatsapp_form.completed` (see [WhatsApp forms](#whatsapp-forms)). |
| `POST /_sandbox/mac`, `GET /_sandbox/mac` | The account's MAC: `{"lockout": true, "active_contact_ids": [2001], "inactive_contact_ids": []}`. With `lockout`, sends to contacts that are not active answer `429 mac_lockout_24h`; an inactive contact always gets it. |
| `POST /_sandbox/contacts/{id}/tags` with `{"tag_id": 4001}`, `DELETE /_sandbox/contacts/{id}/tags/{tag}` | Someone tags the contact in the panel: `contact.tag_added` and `contact.tag_removed`. |
| `POST /_sandbox/devices/{id}/disconnect`, `…/connect` | The number disconnects (`{"reason": "meta_account_not_registered"}`; `qr_logged_out` for QR and `unknown` for official ones by default) or connects, which is the scan of a QR (`{"number": "5491155550101"}`, a fake one otherwise): `device.disconnected` and `device.connected`. Disconnected, sends answer `422 device_unavailable`. |
| `POST /_sandbox/devices/{id}/health` | The health of an official number changes: `{"state": "limited"}` (`available`, `limited`, `blocked`, `unknown`) emits `device.health_changed`, only if it changed. |
| `POST /_sandbox/numbers`, `GET /_sandbox/numbers` | The quota of the account: `{"limit": 3, "included": true, "trial": false, "meta_connect": true}`. `GET` also says how many places are in use. |
| `POST /_sandbox/templates/{id}/status` | Meta approves or rejects a template: `{"status": "REJECTED", "reason": "…"}` emits `template.status_changed`. |
| `POST /_sandbox/events/{type}` | Any event of the catalog, with its example; what you send in `{"data": {…}}` overrides it. `GET /_sandbox/events` lists them. `group.message_received` and `group.reaction_added` go out with the shape communities emits (`message.uid` and every key of the message), not with the example of the accounts catalog, which uses `message.id`. |
| `POST /_sandbox/window` | Opens or closes the window by hand: `{"contact_id": 2001, "device_id": 3, "open": false}`. |
| `POST /_sandbox/reset` | Back to the initial state. |
| `GET /_sandbox/state`, `/_sandbox/requests`, `/_sandbox/deliveries` | The state, the last requests and the last deliveries with what your server answered. |

Besides, as in the API: creating a contact emits `contact.created`, closing a conversation (`active_conversation: false`) emits `conversation.closed`, assigning it emits `conversation.assigned`, and a template created through the API goes from `PENDING` to `APPROVED` after 5 seconds with `template.status_changed`.

**The panel** is at `http://localhost:4010/_sandbox`: the last requests, the webhook deliveries with your server's answer, and a form to send an incoming message.

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
- **One account and every permission:** any well-formed key gets in, is never revoked and there is no `403 permission_denied`. API keys are not created here, and subscriptions are not filtered by the key's areas (the real API answers `422` on `events` if the key lacks the event's `{area}:read`). The only `403 route_not_available` is the one of the routes no key enables.
- **There are no daily call caps** (`429 daily_cap_exceeded`), no `503 gate_unavailable` and no balance: to test those cases, force the failure. Of the MAC there is the lockout (`429 mac_lockout_24h`); `429 mac_limit_reached` is only forced, and the real API also stores in the history an error row for every send stopped by the MAC, which the sandbox does not.
- **The state is memory only:** it is lost when the process stops or with `POST /_sandbox/reset`. So your receiver does not lose the secret, put the subscription in the configuration file.
- **The routes without state** answer an example built from the schema, always the same, even if it does not match your data.
- **The validation messages** are Laravel's in Spanish, built from the schema: they may not match the API's word for word (decide by the HTTP status and by `error`, not by `message`). The real API's validation `422` is Laravel's, `{message, errors}`, without `error`; the sandbox adds `"error": "validation_failed"`.
- **Webhook URLs** may be `http` and local, without the real API's protection against internal destinations (try `--require-https`). Do not expose the sandbox to the internet: the `/_sandbox` routes take no key and the sandbox `POST`s to any URL subscribed to it.
- **The catalog** is transcribed from the code of accounts v1.4.24 (`spec/catalog.json`), not read from a response: if accounts changes it, it has to be transcribed again.
- **There are no groups or campaigns with state:** their events are fired from `/_sandbox`, and their routes answer examples.
- **Forms do not talk to Meta:** `sync` and `publish` succeed unless the linter finds an error, and the linter is a short version of the real one (screens without a title, without an ending, without questions, with a connection to the server). There are no metrics (`…/metrics`) and no dynamic forms.
- **Files are not downloaded:** the type comes from the extension or from `file_type`. The «known» extensions (the ones that give `415` instead of `422 errors.file_type`) are the common ones; the API uses symfony/mime's full list.
- **Connecting numbers** follows a contract, not production: no real QR, no Meta Embedded Signup and no 15-minute hold of a pool number. A QR link that fails does not create (and delete) a number, the creation of links has no per-minute limit, links do not die when a key is revoked, and `409 operation_in_progress` only appears if two calls with the same `Idempotency-Key` overlap.
- **The pace and the brakes** use the numbers of conversations in production (`config/send_guards.php`, `config/antiblock.php`); the official number paired with a QR one in coexistence (15 per second, shared) is not there.

## Pending of the spec

The spec's snapshot (`spec/funnelchat.json`) is the portal's of 15-10. What went to production afterwards, or what the portal does not document yet, is in two separate layers that the next regeneration replaces on its own once the snapshot carries it:

- `spec/pending.json`: the pending layer of the Node SDK, copied unchanged (`funnelchat-node` `feat/inicial` @ `88557ce`).
- `spec/pending-sandbox.json`: what the sandbox adds, with its sources inside.

Besides, `spec/catalog.json` is the event catalog of accounts v1.4.24, with its provenance.

| What | Where it comes from | Status |
|---|---|---|
| Webhook subscriptions: `/api/v1/webhooks`, `/{id}`, `rotate-secret`, `test`, `deliveries` | accounts v1.4.24 | In production. |
| The send with a key: `200` with the queued message, `GET /api/v1/contacts/{contact}/messages/{message}`, `client_reference`, `error.reason` and the errors of the rules | conversations v1.18.10 | In production since 21-10. |
| `message.status_changed` and `device_id` in `message.received` | conversations v1.18.10 | In production; `message.status_changed` is `active`. |
| The file by URL: `file_type`, `file_name`, their `422`s and the `415` | conversations v1.18.10 (`SendFileType`) | In production. |
| Forms: `/api/v1/forms…`, `POST /api/v1/contacts/{contact}/message/form` and `whatsapp_form.completed` | conversations v1.18.10 | In production. The portal does not document them yet. |
| `capabilities` and the new keys of the numbers | accounts v1.4.24 (`DeviceResource`, `DeviceCapabilities`) | In production. |
| Connecting numbers: `POST /api/v1/devices`, `GET …/{device}/qr`, `external_reference`, `/api/v1/connect-links…`, `/connect/{token}`, `Idempotency-Key`, `device.deleted`, `device.health_changed` and the new keys of `device.connected` and `device.disconnected` | The contract of the sign-up by API of 22-10 (A1, A3) | Not in production: accounts is building it. |
| `X-Request-Id` and the edge's errors (`route_not_found`, `origin_unreachable`, `edge_misconfigured`) | api-edge v0.3.0, platform-gate v0.8.0 | In production. |

## Regenerating

Everything generated comes from a single script:

```bash
# With a new snapshot of the portal (`npm run datos` generates it in developers-portal):
npm run generate -- --spec ../developers-portal/public/specs/funnelchat.json

# With a new pending layer of the Node SDK:
npm run generate -- --pending ../funnelchat-node/spec/pending.json

# With what is already in spec/ (for example, after touching spec/pending-sandbox.json):
npm run generate

# To check that generated/ is up to date (useful in CI):
npm run generate:check
```

What it does:

1. With `--spec` or `--pending`, it copies the file to `spec/` and writes in `spec/procedencia.json` the repository, the branch, the commit, the date and the `sha256`.
2. It applies over the snapshot `spec/pending.json` and then `spec/pending-sandbox.json`, but **only what the snapshot lacks**. At the end it lists what the snapshot already carries, so you can delete it.
3. It writes `generated/openapi.json`, the spec the sandbox validates and answers with.

**The current snapshot** is the portal's of 15-10 (branch `feat/openapi-unificada` @ `0ef4abb`, merged since): 191 paths and 230 operations of conversations `9d723d52c`, communities `fab0bb10` and accounts `c234b6f8`. The detail is in `spec/procedencia.json`.

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
spec/            the spec, its provenance, the two pending layers and the event catalog
scripts/         generate.mjs, the only generator
generated/       the merged spec (not edited)
src/openapi/     routes, validation and examples from the spec
src/handlers/    the routes with state (contacts, messages, forms, webhooks) and the ones the gate closes
src/forms/       the form templates
src/messaging/   send rules, the file by URL, forced failures and message statuses
src/webhooks/    signature, catalog, deliveries and retries
src/sandbox/     the /_sandbox routes and the panel
test/            vitest
```

**Publishing:** push a `vX.Y.Z` tag on `main` that matches the `version` in `package.json`; GitHub Actions publishes it through npm Trusted Publishing (`.github/workflows/publish.yml`).

## License

[MIT](LICENSE).
