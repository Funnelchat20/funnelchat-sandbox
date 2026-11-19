# Changelog

## 0.7.0 (18-11-2026)

Follows the spec the developer portal publishes on 18-11 (the snapshots of conversations, communities and accounts):
the contract test finds no difference between the sandbox and that spec.

### Changes that can break an integration

- **A form is sent by its family:** `form_id` of `POST /api/v1/contacts/{contact}/message/form` is the `frm_…` id
  (`family_id`), as production takes it, and the send goes out with the current published version. A version id
  (`frv_…`) is a `422` on `form_id`; before, the sandbox wanted it and answered `404 form_not_found` to the family.
- **Template variables go by number:** `template_variables.body` is `{"1": "Lucía"}`. Without `template_variables`,
  each `{{n}}` takes the field the template chose in `params.body`. A value can carry the contact's fields
  (`{name}`, `{first_name}`, `{email}`, `{phone}` or a custom field); one the account does not have is
  `422 template_unresolved_placeholder`.
- **Creating a template** asks for `device_id`, `file` unless `type` is `text`, and a field and a sample for every
  `{{n}}` in `params` (`{"body": {"1": "{name}"}, "samples": {"body": {"1": "Lucía"}}}`); it answers `201`.
- **`POST /api/v1/contacts/{contact}/message`** takes `contact_id` and `phone` (or `whatsapp_id`) in the body, and
  only that route sends a menu: `send-message` does not read `options`.
- **`GET /api/v1/webhooks` is always a page** (`{data, links, meta}`, 25 by default).
- **A query boolean is `1` or `0`**, as Laravel's `boolean` rule reads it: `?activeConversation=true` is a `422`.

### Like production

- Creating a tag or a custom field with a name the account has answers that one with `200`, without a duplicate; a
  new name answers `201`.
- Contacts: `""` where there is no name, email, phone, WhatsApp id or photo; `last_message` only when there is one;
  the detail adds `opted_out` and `name_mismatch`; a contact's custom field has an integer `type`. `user_id` is an
  opaque id (`usr_…`). `POST /api/v1/contacts` and `update-or-create` keep `custom_fields`, and `add-tags` /
  `remove-tags` keep the tags and emit `contact.tag_added` / `contact.tag_removed`.
- `GET /api/v1/conversations` answers the row conversations builds (the contact's columns and the last message's),
  with `links.first` and `meta.total`. Pagination links copy the query as you sent it.
- Numbers carry `phone_number_id` and, in `health`, `verified_name` and `meta_status`; a sign-up link has
  `url: null` after the answer that created it. `device.disconnected` no longer brings `provider_error`.
- Groups answer communities' messages for `perPage` and `media_url`.
- The event catalog carries `is_critical` and `label`. `template.status_changed` brings `reason: null` on a review
  of Meta.
- Validation errors of conditional rules name the field, as Laravel does («obligatorio cuando…», «prohibido»).
- `POST /_sandbox/inbound` with `reply` taps a button of a message you sent (`interactive` or
  `template_button_reply`).

### Also

- A webhook receiver on your machine works: `http://localhost` and `http://127.0.0.1` are accepted, though the real
  API asks for a public `https` URL (`--require-https` imitates it).
- The contract test (`test/contract.test.ts`) walks the 253 operations of the published spec.
- `fast-uri`, which the package installs through `ajv`, goes to a fixed version.

## 0.6.0

Follows the portal's v0.7.0: the ids of the public API are opaque (`ctc_…`, `dev_…`, `msg_…`). See «Migrating to
0.6.0» in the README.

## Earlier versions

0.5.x follow the portal's v0.6.14 to v0.6.19, and 0.4.0 answers every function the portal publishes, shape only where
nothing is simulated. The history is in the repository's commits.
