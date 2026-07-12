# CLONE FRAME · HUB Bridge — Contacts Engine

`contacts.mjs` is the HUB's address book: manual contacts, vCard/CSV import, and
real CardDAV sync. Zero npm dependencies — Node built-ins only. CardDAV uses
global `fetch` (REPORT + Basic auth); vCard, CSV, and the CardDAV multistatus
XML are all parsed by hand-rolled scanners in this file (no `vcard`/`xml2js`/etc).

Contacts persist to `~/.clone-frame-hub/contacts.json` (`chmod 600`, directory
`chmod 700`). **CardDAV credentials are never persisted** by this module — callers
pass `{url, user, pass}` per call to `carddavSync`; only the resulting contacts
(no password) are written to the store.

## Import

```js
import { Contacts } from './contacts.mjs';
// or: import Contacts from './contacts.mjs';                  (default export, same object)
// or: import { list, add, importVCard, carddavSync } from './contacts.mjs'; (named exports)
```

`Contacts` is a plain object of the functions below — pick whichever import
style fits `hub-bridge.mjs`'s existing router style.

## Error model

Every function is synchronous and returns a plain value or `{ok, ...}` object.
**None of them throw** — malformed vCard/CSV input, a missing id, or a CardDAV
network/parse failure all resolve to `{ok: false, error: string}` (or, for
`list`/`get`/`count`, an empty/`null`/`0` result). This matches the "write-path
never throws" convention used by `email.mjs`'s account functions.

## Route contract

```
list({search='', limit=500}={}) -> Contact[]
  search: case-insensitive substring match against displayName, org, and any email.
  limit:  max rows returned (post-filter).

get(id) -> Contact | null

add({displayName, emails=[], phones=[], org=''}) -> {ok, id?, error?}
  Requires at least one of displayName / emails / phones.

update(id, patch) -> {ok, error?}
  patch: any subset of {displayName, emails, phones, org}. Arrays replace
  (not append) the existing arrays, then dedupe.

remove(id) -> {ok, error?}

importVCard(text) -> {ok, imported, skipped}
  text: one or more concatenated BEGIN:VCARD…END:VCARD blocks (RFC 6350
  subset: FN, N, EMAIL, TEL, ORG; folded lines are unfolded first).
  Cards with no FN/N, no EMAIL, and no TEL are counted as skipped.

importCSV(text) -> {ok, imported, skipped}
  text: CSV with a header row (case-insensitive; recognizes name/full name/
  display name, email/email address, phone/phone number/telephone/tel/mobile,
  org/company/organization). If no recognizable header is found, falls back
  to positional columns: name,email,phone,org. Quoted fields (with embedded
  commas/newlines/escaped "") are handled.

carddavSync({url, user, pass}) -> Promise<{ok, imported?, error?}>
  Sends an addressbook-query REPORT (Depth:1, Basic auth if user is given) to
  the CardDAV collection at `url`, scans the multistatus XML response for
  <address-data> (namespace-prefixed or not) blocks via regex, decodes basic
  XML entities, parses each as a vCard, and merges. Any HTTP/network/parse
  failure resolves to {ok:false, error} — this function never throws and
  never persists the password.

count() -> number
```

## Merge / dedupe rule

All three import paths (`importVCard`, `importCSV`, `carddavSync`) route
through the same merge step: contacts are deduped by their **lowercased
primary email** (`emails[0]`). If an incoming contact's primary email matches
an existing contact, the existing row is updated in place (arrays are unioned,
`org`/`displayName` overwritten if the incoming value is non-empty, `source`
and `updatedAt` refreshed) rather than duplicated. Contacts with no email at
all are always inserted as new rows, since there is nothing to key on.

## Contact JSON shape

```jsonc
{
  "id": "b3e1...",                       // randomUUID()
  "displayName": "Jane Doe",
  "emails": ["jane.doe@example.com", "jane@personal.com"],
  "phones": ["+1-555-0200"],
  "org": "Widget Inc",
  "source": "manual",                    // "manual" | "vcard" | "csv" | "carddav"
  "updatedAt": "2026-07-09T18:32:10.512Z"
}
```

## Self-test

Run directly (no test framework, no deps):

```
node --check contacts.mjs
```

A one-off self-test script (add/list/update/remove a manual contact; import a
2-card vCard sample and assert `imported:2` with emails parsed correctly;
import a quoted-CSV sample; verify `~/.clone-frame-hub/contacts.json` is
written with `0600`/`0700` perms; call `carddavSync` against an unreachable
URL and confirm it resolves `{ok:false, error}` without throwing) was run
during development and is not shipped as part of this module (no test
framework dependency was added, per the zero-deps constraint).
