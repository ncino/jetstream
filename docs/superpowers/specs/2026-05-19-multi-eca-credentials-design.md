# Multi-ECA Salesforce Credentials — Design

## Problem

Jetstream today supports a single Salesforce External Client App (ECA): one
`SFDC_CONSUMER_KEY` / `SFDC_CONSUMER_SECRET` pair is read from `ENV` and used
for every OAuth flow regardless of which Salesforce org the user is logging
into. ECAs cannot be packaged and distributed across orgs, so deployments that
need to authenticate users into multiple orgs (e.g. nCino's production +
ncinodev sandbox + partialdev sandbox) need separate consumer key/secret pairs
— one per org that hosts an ECA. The current code cannot route the OAuth flow
to the correct ECA, so only one of the three orgs is reachable at a time.

This design adds first-class support for multiple ECAs in server config, lets
users pick which ECA to authenticate through, persists the choice per
Salesforce org so token refreshes use the right credentials, and keeps existing
single-ECA deployments working unchanged.

## Goals

- Support N (≥1) ECAs, configured at server startup via env vars.
- Let users pick the ECA in the AddOrg UI; default the choice based on the
  selected login URL but always allow override.
- Persist the chosen ECA per `SalesforceOrg` so token refresh uses the matching
  key/secret.
- Keep `SFDC_CONSUMER_KEY` / `SFDC_CONSUMER_SECRET` working as a single-ECA
  back-compat shim for one release.
- Decouple legacy v1 token decryption from the active ECA list via a separate
  `SFDC_LEGACY_CONSUMER_SECRET` env var.

## Non-goals

- Per-user or per-tenant ECA selection — the registry is server-wide.
- Rotating ECA secrets without user re-auth.
- Auto-detecting which ECA a token came from when both refresh and fallback
  fail. Existing "invalid token → user reconnects" path covers this.
- E2E test coverage for multi-ECA flows. The existing OAuth-mocked flows still
  cover the single-ECA happy path; a multi-ECA E2E is a follow-up once
  fixtures exist.

## Architecture

### ECA registry

A new module in `libs/api-config` (sibling to `env-config.ts`) loads and
validates ECAs at startup and exposes a typed registry to the rest of the
server.

**Env var schema.** Each ECA is a numbered set:

```
SFDC_ECA_<N>_ID            required, kebab-case slug, unique, stable
SFDC_ECA_<N>_LABEL         required, shown in UI dropdown
SFDC_ECA_<N>_KEY           required
SFDC_ECA_<N>_SECRET        required
SFDC_ECA_<N>_DEFAULT_FOR   optional, comma-separated tokens or URLs
```

`DEFAULT_FOR` accepts short tokens that expand to canonical login URLs:

| Token         | Expands to                                  |
|---------------|---------------------------------------------|
| `prod`        | `https://login.salesforce.com`              |
| `sandbox`     | `https://test.salesforce.com`               |
| `pre-release` | `https://prerellogin.pre.salesforce.com`    |

Raw `https://*.my.salesforce.com` URLs are also accepted verbatim.

**Loader behavior.** Scans `SFDC_ECA_N_*` for ascending N starting at 1, stops
at the first gap. Validates:

- At least one ECA loaded.
- IDs unique across the set; each matches `^[a-z0-9-]+$`.
- All required fields present per ECA.
- `DEFAULT_FOR` tokens recognized; raw URLs match the same set the existing
  OAuth route validator already accepts.

Validation failures throw at startup so the server never boots into a partial
config.

**Back-compat shim.** If `SFDC_CONSUMER_KEY` and `SFDC_CONSUMER_SECRET` are set
**and** no `SFDC_ECA_*` vars exist, the loader auto-registers a synthetic ECA:

```ts
{ id: 'default', label: 'Default', key, secret, defaultFor: [] }
```

If both formats are present simultaneously the server fails to start with a
clear error — silent hybrid behavior would be a footgun. The shim exists for a
single release and gets a deprecation warning logged at boot. A follow-up
release removes the shim entirely.

**Public API.**

```ts
type EcaConfig = {
  id: string;
  label: string;
  key: string;
  secret: string;
  defaultFor: string[]; // canonical URLs after expansion
};

function getEcas(): EcaConfig[];
function getEcaById(id: string): EcaConfig | null;
function getDefaultEcaForLoginUrl(loginUrl: string): EcaConfig | null;
function getLegacyConsumerSecret(): string | null;
```

`getDefaultEcaForLoginUrl` returns the first ECA whose `defaultFor` contains
the URL; if no ECA matches, returns the first ECA in the list as the overall
fallback. This guarantees a non-null result whenever at least one ECA is
configured, which matches the registry's startup invariant.

### OAuth flow

**Init route** (`apps/api/src/app/controllers/oauth.controller.ts:60-72`).
The query validator gains an optional `ecaId`:

```ts
ecaId: z.string().optional()
```

The controller resolves the ECA:

```ts
const eca = query.ecaId
  ? getEcaById(query.ecaId)
  : getDefaultEcaForLoginUrl(query.loginUrl);
if (!eca) {
  // 400: unknown ECA id
}
```

It then passes `eca.key` / `eca.secret` to `oauthService.salesforceOauthInit`
in place of `ENV.SFDC_CONSUMER_KEY` / `ENV.SFDC_CONSUMER_SECRET`. The chosen
`eca.id` is stashed in `req.session.orgAuth` alongside the existing
`code_verifier` / `nonce` / `state` / `loginUrl`.

**Callback route** (`oauth.controller.ts:79-126`). Reads `eca.id` from session,
re-resolves it via `getEcaById`, uses the same key/secret to exchange the
authorization code, and persists `ecaId` on the new `SalesforceOrg` row. If
the session-stored ECA id no longer exists in the registry (e.g. removed from
env between init and callback), error out with a clear message.

### Token refresh

`apps/api/src/app/routes/route.middleware.ts:422-423` currently passes the
single `ENV.SFDC_CONSUMER_KEY/SECRET`. Replace with a resolver:

```ts
const eca =
  (org.ecaId && getEcaById(org.ecaId)) ??
  getDefaultEcaForLoginUrl(org.loginUrl);
```

If `ecaId` is set but the ECA was removed from env, fall back to the loginUrl
default rather than failing the request — and log a warning so it's visible.
If neither resolves, error.

### Encryption service

`apps/api/src/app/services/salesforce-org-encryption.service.ts:133` is the
only remaining use of `ENV.SFDC_CONSUMER_SECRET` in the encryption path, and
it's exclusively for decrypting legacy v1 tokens. Replace with
`getLegacyConsumerSecret()`:

- v2 encryption is unaffected — it already uses `SFDC_ENCRYPTION_KEY`.
- If `SFDC_LEGACY_CONSUMER_SECRET` is unset and a v1 token is encountered,
  decryption fails fast and returns the existing `DUMMY_INVALID_ENCRYPTED_TOKEN`
  sentinel, which causes the org to be marked invalid and the user to re-auth
  on next use.

### Database schema

Add `ecaId` to `SalesforceOrg` in `prisma/schema.prisma`:

```prisma
model SalesforceOrg {
  // ...existing fields
  ecaId String?
}
```

Nullable. No backfill — existing rows have `null`, which the refresh resolver
already handles by falling back to the loginUrl default. Migration is created
via the Prisma CLI per project conventions; no manual migration files.

### UI

**AddOrg form** (`libs/shared/ui-core/src/orgs/AddOrg.tsx`). Add a "Connected
App" dropdown alongside the existing "Type" dropdown. Always visible.

- Populated from a new `GET /api/salesforce/ecas` endpoint that returns
  `[{ id, label, defaultFor }]`. Never returns key/secret.
- When the user changes the org-type dropdown, recompute the default ECA
  selection from the resulting login URL using the same defaulting rule the
  server uses (mirrored in client code; the endpoint payload includes
  `defaultFor` for that purpose).
- The user can override the auto-selected ECA. The current selection is
  preserved when the user changes org type if it's still valid for the new
  login URL; otherwise it snaps to the new default.
- If only one ECA is configured, the dropdown still renders but is disabled
  with the single option selected.
- Submit passes `ecaId` as a query param to the OAuth init route.

**Org list display.** When more than one ECA is configured, show the ECA label
as a small subtitle on `SalesforceOrg` cards / dropdown rows. If the persisted
`ecaId` no longer maps to a configured ECA, render "Unknown connected app" in
muted text.

### Setup scripts

`scripts/podman-setup-mac.sh` and `scripts/generate.env.mjs` replace the single
key/secret prompt with a loop:

```
=== Salesforce Connected App (ECA) credentials ===
You can configure multiple ECAs (e.g. one per Salesforce org).

ECA #1
  ID (short slug, e.g. 'prod', 'ncinodev'): _
  Label (shown in UI, e.g. 'Production'): _
  Consumer Key: _
  Consumer Secret: _
  Default for which org type? (optional)
    1) Production (login.salesforce.com)
    2) Sandbox (test.salesforce.com)
    3) Pre-release (prerellogin.pre.salesforce.com)
    4) None — user picks this from the UI dropdown
  Choice [4]: _

Add another ECA? (y/N) _
```

Validation per iteration: `id` matches `^[a-z0-9-]+$`, `id` not duplicated,
key/secret/label non-empty. Writes the resulting set as `SFDC_ECA_1_*` …
`SFDC_ECA_N_*` to `.env`. The org-type prompt outputs a token (`prod` /
`sandbox` / `pre-release`) into `DEFAULT_FOR`, not a URL, so admins never type
a Salesforce hostname.

If `.env` already contains `SFDC_CONSUMER_KEY` when the script runs, the
script prompts: "Existing single-ECA config detected. Migrate to numbered ECA
format? (Y/n)" — on yes it comments out the legacy lines and appends the new
numbered ones.

The two scripts share neither an interpreter nor a runtime, so the validation
logic is duplicated inline rather than abstracted.

### Documentation

- `README.md:122-138` — rewrite the Connected App section. Each Salesforce org
  that hosts an ECA gets its own numbered set of env vars; document the format
  with a 2-ECA example; note that `SFDC_CONSUMER_KEY/SECRET` still work as a
  single-ECA shorthand for one release.
- `docs/LOCAL_SETUP_GUIDE.md` — update the credentials step to describe the
  loop and the option to add multiple ECAs; reference 1Password entries per
  ECA.
- `.env.example` — replace the single-ECA block with a 2-ECA template plus the
  new `SFDC_LEGACY_CONSUMER_SECRET`.

## Data flow

```
AddOrg form
  ├─ user picks org type → loginUrl
  ├─ default ECA = first match in cached /api/salesforce/ecas where
  │                  defaultFor includes loginUrl, else first ECA
  ├─ user may override via dropdown
  └─ submit → /oauth/sfdc/auth?loginUrl=...&ecaId=<id>

OAuth init
  ├─ resolve EcaRegistry.getEcaById(ecaId) || getDefaultEcaForLoginUrl(loginUrl)
  ├─ stash eca.id in session.orgAuth
  └─ build authorization URL with eca.key

OAuth callback
  ├─ read eca.id from session.orgAuth
  ├─ resolve EcaRegistry.getEcaById(eca.id) (error if gone)
  ├─ exchange code with eca.key + eca.secret
  └─ persist SalesforceOrg.ecaId = eca.id

Token refresh (route.middleware)
  ├─ resolve (org.ecaId && getEcaById) ?? getDefaultEcaForLoginUrl(org.loginUrl)
  └─ refresh with eca.key + eca.secret

Legacy v1 token decrypt
  └─ getLegacyConsumerSecret() — never tied to active ECAs
```

## Failure modes

| Scenario                                    | Behavior                                                                 |
|---------------------------------------------|--------------------------------------------------------------------------|
| Both legacy and `SFDC_ECA_*` vars set       | Server fails to start with explicit error                                |
| `SFDC_ECA_*` ID not unique / invalid slug   | Server fails to start                                                    |
| `ecaId` query param unknown at OAuth init   | 400 from controller                                                      |
| ECA removed from env between init and cb    | Callback errors with clear message                                       |
| ECA removed from env after org saved        | Refresh falls back to loginUrl default ECA, logs a warning               |
| `SFDC_LEGACY_CONSUMER_SECRET` unset, v1 tok | v1 decrypt returns DUMMY_INVALID_ENCRYPTED_TOKEN → user re-authenticates |
| Only one ECA configured                     | UI dropdown renders, disabled, single option selected                    |

## Testing

Per CLAUDE.md (Vitest, co-located in `__tests__/`):

- **`libs/api-config/src/lib/__tests__/eca-registry.spec.ts`** — env parsing
  (ascending scan, gap detection, dup-id rejection, slug validation),
  back-compat shim auto-registers a single ECA, hard-error when both formats
  present, `defaultFor` token expansion, `getDefaultEcaForLoginUrl`
  first-match-wins and overall fallback.
- **`apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts`** —
  init resolves ECA from query param vs login-URL default, callback persists
  `ecaId`, callback errors when session ECA id no longer exists.
- **`apps/api/src/app/routes/__tests__/route.middleware.spec.ts`** — refresh
  uses persisted `ecaId`; falls back to loginUrl default when ECA was removed;
  logs a warning on fallback; errors when neither resolves.
- **`apps/api/src/app/services/__tests__/salesforce-org-encryption.service.spec.ts`**
  — v1 decrypt uses `SFDC_LEGACY_CONSUMER_SECRET`; returns
  `DUMMY_INVALID_ENCRYPTED_TOKEN` when legacy secret is unset; v2 unaffected.
- **`libs/shared/ui-core/src/orgs/__tests__/AddOrg.spec.tsx`** — dropdown
  populates from endpoint, default snaps when org type changes, override is
  preserved, single-ECA case renders disabled.

## Affected files

- `libs/api-config/src/lib/env-config.ts` — make `SFDC_CONSUMER_KEY/SECRET` optional (still read by the back-compat shim in `eca-registry.ts`); add `SFDC_LEGACY_CONSUMER_SECRET` (optional). The numbered `SFDC_ECA_N_*` vars are read directly by the registry, not declared in this schema.
- `libs/api-config/src/lib/eca-registry.ts` — new.
- `libs/api-config/src/lib/__tests__/eca-registry.spec.ts` — new.
- `apps/api/src/app/controllers/oauth.controller.ts` — ECA-aware init + callback.
- `apps/api/src/app/routes/route.middleware.ts` — ECA-aware refresh.
- `apps/api/src/app/services/salesforce-org-encryption.service.ts` — `getLegacyConsumerSecret()`.
- `apps/api/src/app/controllers/salesforce-eca.controller.ts` — new endpoint.
- `apps/api/src/app/routes/...` — wire the new endpoint.
- `prisma/schema.prisma` — add `ecaId` to `SalesforceOrg`.
- `libs/shared/ui-core/src/orgs/AddOrg.tsx` — dropdown + default logic.
- Org list rendering files (TBD during implementation; locate via grep).
- `scripts/podman-setup-mac.sh` — loop prompt.
- `scripts/generate.env.mjs` — loop prompt.
- `.env.example` — new template.
- `README.md` — Connected App section rewrite.
- `docs/LOCAL_SETUP_GUIDE.md` — multi-ECA instructions.
