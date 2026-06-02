# Multi-ECA Salesforce Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Jetstream authenticate users into Salesforce orgs that use different External Client Apps (ECAs) by configuring multiple consumer key/secret pairs and routing OAuth + token-refresh to the correct one per org.

**Architecture:** Server-side **EcaRegistry** module loads N ECAs from numbered env vars (`SFDC_ECA_1_*` … `SFDC_ECA_N_*`), with a back-compat shim for the legacy single-ECA env vars. The OAuth init/callback controller, token-refresh middleware, and a new `GET /api/salesforce/ecas` endpoint all consume the registry. The AddOrg UI shows a "Connected App" dropdown, defaults the choice from the selected login URL, and persists the chosen ECA id on the `SalesforceOrg` row so refresh uses the right credentials. Legacy v1-encrypted tokens decrypt against a separate `SFDC_LEGACY_CONSUMER_SECRET` env var.

**Tech Stack:** TypeScript, Zod, Express, Prisma, React 19 + Jotai, Vitest, bash, zx (Node), Nx monorepo.

---

## File Structure

### New files

- `libs/api-config/src/lib/eca-registry.ts` — ECA loader, validator, and lookup API. Exports `EcaConfig`, `EcaPublic`, `getEcas`, `getEcaById`, `getDefaultEcaForLoginUrl`, `getLegacyConsumerSecret`, `loadEcaRegistry`.
- `libs/api-config/src/lib/__tests__/eca-registry.spec.ts` — unit tests for the loader and lookup.
- `apps/api/src/app/controllers/salesforce-eca.controller.ts` — `GET /api/salesforce/ecas` returning the public list.
- `apps/api/src/app/controllers/__tests__/salesforce-eca.controller.spec.ts` — unit test for the new endpoint.
- `apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts` — extended OAuth init/callback tests for ECA resolution + persistence (file may already exist; create if not).
- `apps/api/src/app/routes/__tests__/route.middleware.spec.ts` — refresh-time ECA resolution tests (file may already exist; create if not).
- `apps/api/src/app/services/__tests__/salesforce-org-encryption.service.spec.ts` — legacy decrypt against `SFDC_LEGACY_CONSUMER_SECRET` (file may already exist; create if not).
- `libs/shared/ui-core/src/orgs/__tests__/AddOrg.spec.tsx` — UI test for the dropdown, default snapping, and override.

### Modified files

- `libs/api-config/src/lib/env-config.ts` — make `SFDC_CONSUMER_KEY/SECRET` optional, add `SFDC_LEGACY_CONSUMER_SECRET` (optional). The numbered `SFDC_ECA_N_*` vars are read by the registry, not Zod-validated here.
- `libs/api-config/src/index.ts` — re-export the registry API.
- `apps/api/src/app/controllers/oauth.controller.ts` — accept `ecaId` query param; resolve ECA on init + callback; stash ECA id in session; persist `ecaId` on the `SalesforceOrg`.
- `apps/api/src/app/routes/oauth.routes.ts` — no change to routes file (controller validators carry the schema), but the new ECAs endpoint will be wired here or in a sibling `salesforce-eca.routes.ts`.
- `apps/api/src/app/routes/route.middleware.ts:422-423` — replace `ENV.SFDC_CONSUMER_KEY/SECRET` with registry resolver.
- `apps/api/src/app/services/salesforce-org-encryption.service.ts:133` — replace `ENV.SFDC_CONSUMER_SECRET` with `getLegacyConsumerSecret()`.
- `apps/api/src/app/db/salesforce-org.db.ts` — pass through `ecaId` in `createOrUpdateSalesforceOrg`.
- `prisma/schema.prisma:534-577` — add `ecaId String?` to `SalesforceOrg`.
- `libs/shared/ui-core/src/orgs/AddOrg.tsx` — add ECA dropdown with default snapping, fetch ECAs on mount, pass `ecaId` to `addOrg` handler.
- `libs/shared/ui-utils/src/lib/shared-ui-utils.ts:954-973` — `addOrg` helper accepts `ecaId` and appends to query string.
- `libs/types/src/lib/types.ts:425-428` — `AddOrgHandlerFn` options type gains optional `ecaId`.
- `scripts/podman-setup-mac.sh:128-156` — loop prompt for multiple ECAs.
- `scripts/generate.env.mjs:74-93` — loop prompt for multiple ECAs.
- `.env.example:61-67` — new multi-ECA template + `SFDC_LEGACY_CONSUMER_SECRET`.
- `README.md:122-138` — Connected App section rewrite.
- `docs/LOCAL_SETUP_GUIDE.md` — multi-ECA instructions.

---

## Task 1: Add EcaRegistry module (loader + lookup, no callers yet)

**Files:**
- Create: `libs/api-config/src/lib/eca-registry.ts`
- Create: `libs/api-config/src/lib/__tests__/eca-registry.spec.ts`
- Modify: `libs/api-config/src/index.ts` (re-export from new module)

The registry is callable in two ways: `loadEcaRegistry(env)` for tests (pure function over an env-like record), and a default singleton initialized from `process.env` at first use. This keeps tests deterministic and the prod path clean.

- [ ] **Step 1: Write failing tests for the loader**

Create `libs/api-config/src/lib/__tests__/eca-registry.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { loadEcaRegistry } from '../eca-registry';

describe('loadEcaRegistry', () => {
  it('loads a single ECA from numbered env vars', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'prod',
      SFDC_ECA_1_LABEL: 'Production',
      SFDC_ECA_1_KEY: 'k1',
      SFDC_ECA_1_SECRET: 's1',
      SFDC_ECA_1_DEFAULT_FOR: 'prod',
    });
    expect(reg.getEcas()).toEqual([
      { id: 'prod', label: 'Production', key: 'k1', secret: 's1', defaultFor: ['https://login.salesforce.com'] },
    ]);
  });

  it('loads multiple ECAs in ascending order', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'prod',
      SFDC_ECA_1_LABEL: 'Production',
      SFDC_ECA_1_KEY: 'k1',
      SFDC_ECA_1_SECRET: 's1',
      SFDC_ECA_2_ID: 'ncinodev',
      SFDC_ECA_2_LABEL: 'nCino Dev',
      SFDC_ECA_2_KEY: 'k2',
      SFDC_ECA_2_SECRET: 's2',
      SFDC_ECA_2_DEFAULT_FOR: 'sandbox',
      SFDC_ECA_3_ID: 'partialdev',
      SFDC_ECA_3_LABEL: 'Partial Dev',
      SFDC_ECA_3_KEY: 'k3',
      SFDC_ECA_3_SECRET: 's3',
    });
    expect(reg.getEcas().map((eca) => eca.id)).toEqual(['prod', 'ncinodev', 'partialdev']);
  });

  it('stops at the first numeric gap', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'a',
      SFDC_ECA_1_LABEL: 'A',
      SFDC_ECA_1_KEY: 'k',
      SFDC_ECA_1_SECRET: 's',
      // SFDC_ECA_2_* missing entirely
      SFDC_ECA_3_ID: 'c',
      SFDC_ECA_3_LABEL: 'C',
      SFDC_ECA_3_KEY: 'k',
      SFDC_ECA_3_SECRET: 's',
    });
    expect(reg.getEcas().map((eca) => eca.id)).toEqual(['a']);
  });

  it('expands DEFAULT_FOR tokens to canonical URLs', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'a',
      SFDC_ECA_1_LABEL: 'A',
      SFDC_ECA_1_KEY: 'k',
      SFDC_ECA_1_SECRET: 's',
      SFDC_ECA_1_DEFAULT_FOR: 'prod,sandbox,pre-release,https://acme.my.salesforce.com',
    });
    expect(reg.getEcas()[0].defaultFor).toEqual([
      'https://login.salesforce.com',
      'https://test.salesforce.com',
      'https://prerellogin.pre.salesforce.com',
      'https://acme.my.salesforce.com',
    ]);
  });

  it('throws when no ECAs are configured and no legacy vars are present', () => {
    expect(() => loadEcaRegistry({})).toThrow(/at least one ECA/i);
  });

  it('throws when ECA ids are not unique', () => {
    expect(() =>
      loadEcaRegistry({
        SFDC_ECA_1_ID: 'dup',
        SFDC_ECA_1_LABEL: 'A',
        SFDC_ECA_1_KEY: 'k',
        SFDC_ECA_1_SECRET: 's',
        SFDC_ECA_2_ID: 'dup',
        SFDC_ECA_2_LABEL: 'B',
        SFDC_ECA_2_KEY: 'k',
        SFDC_ECA_2_SECRET: 's',
      }),
    ).toThrow(/duplicate ECA id/i);
  });

  it('throws when an ECA id has invalid characters', () => {
    expect(() =>
      loadEcaRegistry({
        SFDC_ECA_1_ID: 'Bad ID!',
        SFDC_ECA_1_LABEL: 'A',
        SFDC_ECA_1_KEY: 'k',
        SFDC_ECA_1_SECRET: 's',
      }),
    ).toThrow(/invalid ECA id/i);
  });

  it('throws when both legacy and numbered vars are present', () => {
    expect(() =>
      loadEcaRegistry({
        SFDC_CONSUMER_KEY: 'legacy',
        SFDC_CONSUMER_SECRET: 'legacy',
        SFDC_ECA_1_ID: 'prod',
        SFDC_ECA_1_LABEL: 'Production',
        SFDC_ECA_1_KEY: 'k',
        SFDC_ECA_1_SECRET: 's',
      }),
    ).toThrow(/cannot mix/i);
  });

  it('back-compat shim: registers a synthetic default ECA from legacy vars', () => {
    const reg = loadEcaRegistry({
      SFDC_CONSUMER_KEY: 'legacy-key',
      SFDC_CONSUMER_SECRET: 'legacy-secret',
    });
    expect(reg.getEcas()).toEqual([
      { id: 'default', label: 'Default', key: 'legacy-key', secret: 'legacy-secret', defaultFor: [] },
    ]);
  });
});

describe('EcaRegistry lookups', () => {
  const reg = loadEcaRegistry({
    SFDC_ECA_1_ID: 'prod',
    SFDC_ECA_1_LABEL: 'Production',
    SFDC_ECA_1_KEY: 'k1',
    SFDC_ECA_1_SECRET: 's1',
    SFDC_ECA_1_DEFAULT_FOR: 'prod',
    SFDC_ECA_2_ID: 'ncinodev',
    SFDC_ECA_2_LABEL: 'nCino Dev',
    SFDC_ECA_2_KEY: 'k2',
    SFDC_ECA_2_SECRET: 's2',
    SFDC_ECA_2_DEFAULT_FOR: 'sandbox',
    SFDC_ECA_3_ID: 'partialdev',
    SFDC_ECA_3_LABEL: 'Partial Dev',
    SFDC_ECA_3_KEY: 'k3',
    SFDC_ECA_3_SECRET: 's3',
  });

  it('getEcaById returns the matching ECA', () => {
    expect(reg.getEcaById('ncinodev')?.key).toBe('k2');
  });

  it('getEcaById returns null for unknown ids', () => {
    expect(reg.getEcaById('unknown')).toBeNull();
  });

  it('getDefaultEcaForLoginUrl picks the first ECA whose defaultFor includes the URL', () => {
    expect(reg.getDefaultEcaForLoginUrl('https://login.salesforce.com')?.id).toBe('prod');
    expect(reg.getDefaultEcaForLoginUrl('https://test.salesforce.com')?.id).toBe('ncinodev');
  });

  it('getDefaultEcaForLoginUrl falls back to the first ECA when no defaultFor matches', () => {
    expect(reg.getDefaultEcaForLoginUrl('https://acme.my.salesforce.com')?.id).toBe('prod');
  });
});

describe('getLegacyConsumerSecret', () => {
  it('returns SFDC_LEGACY_CONSUMER_SECRET when set', () => {
    const reg = loadEcaRegistry({
      SFDC_LEGACY_CONSUMER_SECRET: 'legacy-decrypt-key',
      SFDC_ECA_1_ID: 'prod',
      SFDC_ECA_1_LABEL: 'Production',
      SFDC_ECA_1_KEY: 'k',
      SFDC_ECA_1_SECRET: 's',
    });
    expect(reg.getLegacyConsumerSecret()).toBe('legacy-decrypt-key');
  });

  it('returns SFDC_CONSUMER_SECRET when only legacy vars are configured (back-compat)', () => {
    const reg = loadEcaRegistry({
      SFDC_CONSUMER_KEY: 'k',
      SFDC_CONSUMER_SECRET: 'legacy-secret',
    });
    expect(reg.getLegacyConsumerSecret()).toBe('legacy-secret');
  });

  it('returns null when nothing is set', () => {
    const reg = loadEcaRegistry({
      SFDC_ECA_1_ID: 'prod',
      SFDC_ECA_1_LABEL: 'Production',
      SFDC_ECA_1_KEY: 'k',
      SFDC_ECA_1_SECRET: 's',
    });
    expect(reg.getLegacyConsumerSecret()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nx test api-config --testPathPattern=eca-registry`
Expected: FAIL — module `../eca-registry` does not exist.

- [ ] **Step 3: Implement the registry**

Create `libs/api-config/src/lib/eca-registry.ts`:

```typescript
const ID_PATTERN = /^[a-z0-9-]+$/;

const TOKEN_TO_URL: Record<string, string> = {
  prod: 'https://login.salesforce.com',
  sandbox: 'https://test.salesforce.com',
  'pre-release': 'https://prerellogin.pre.salesforce.com',
};

export type EcaConfig = {
  id: string;
  label: string;
  key: string;
  secret: string;
  defaultFor: string[];
};

export type EcaPublic = Pick<EcaConfig, 'id' | 'label' | 'defaultFor'>;

export type EcaRegistry = {
  getEcas(): EcaConfig[];
  getEcaById(id: string): EcaConfig | null;
  getDefaultEcaForLoginUrl(loginUrl: string): EcaConfig | null;
  getLegacyConsumerSecret(): string | null;
};

function expandDefaultFor(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (entry.startsWith('https://')) {
        return entry;
      }
      const expanded = TOKEN_TO_URL[entry];
      if (!expanded) {
        throw new Error(`Unknown DEFAULT_FOR token: ${entry}`);
      }
      return expanded;
    });
}

function readNumberedEcas(env: Record<string, string | undefined>): EcaConfig[] {
  const ecas: EcaConfig[] = [];
  for (let n = 1; ; n++) {
    const id = env[`SFDC_ECA_${n}_ID`];
    if (!id) {
      break;
    }
    const label = env[`SFDC_ECA_${n}_LABEL`];
    const key = env[`SFDC_ECA_${n}_KEY`];
    const secret = env[`SFDC_ECA_${n}_SECRET`];
    const defaultForRaw = env[`SFDC_ECA_${n}_DEFAULT_FOR`];

    if (!ID_PATTERN.test(id)) {
      throw new Error(`Invalid ECA id at position ${n}: "${id}" — must match ${ID_PATTERN}`);
    }
    if (!label || !key || !secret) {
      throw new Error(`ECA at position ${n} is missing one of LABEL/KEY/SECRET`);
    }

    ecas.push({
      id,
      label,
      key,
      secret,
      defaultFor: expandDefaultFor(defaultForRaw),
    });
  }
  return ecas;
}

export function loadEcaRegistry(env: Record<string, string | undefined>): EcaRegistry {
  const numbered = readNumberedEcas(env);
  const hasLegacy = Boolean(env.SFDC_CONSUMER_KEY && env.SFDC_CONSUMER_SECRET);

  if (numbered.length > 0 && hasLegacy) {
    throw new Error(
      'Cannot mix legacy SFDC_CONSUMER_KEY/SECRET with numbered SFDC_ECA_N_* vars. Remove the legacy vars or remove the numbered vars.',
    );
  }

  let ecas = numbered;
  if (ecas.length === 0 && hasLegacy) {
    ecas = [
      {
        id: 'default',
        label: 'Default',
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        key: env.SFDC_CONSUMER_KEY!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        secret: env.SFDC_CONSUMER_SECRET!,
        defaultFor: [],
      },
    ];
  }

  if (ecas.length === 0) {
    throw new Error(
      'At least one ECA must be configured. Set SFDC_ECA_1_ID/LABEL/KEY/SECRET (preferred) or SFDC_CONSUMER_KEY/SECRET (legacy).',
    );
  }

  const seen = new Set<string>();
  for (const eca of ecas) {
    if (seen.has(eca.id)) {
      throw new Error(`Duplicate ECA id: "${eca.id}"`);
    }
    seen.add(eca.id);
  }

  const legacySecret =
    env.SFDC_LEGACY_CONSUMER_SECRET || (hasLegacy ? env.SFDC_CONSUMER_SECRET : undefined) || null;

  return {
    getEcas: () => ecas,
    getEcaById: (id) => ecas.find((eca) => eca.id === id) ?? null,
    getDefaultEcaForLoginUrl: (loginUrl) => ecas.find((eca) => eca.defaultFor.includes(loginUrl)) ?? ecas[0] ?? null,
    getLegacyConsumerSecret: () => legacySecret,
  };
}

let cached: EcaRegistry | null = null;
export function getEcaRegistry(): EcaRegistry {
  if (!cached) {
    cached = loadEcaRegistry(process.env);
  }
  return cached;
}

export function resetEcaRegistryForTests(): void {
  cached = null;
}

export function getEcas(): EcaConfig[] {
  return getEcaRegistry().getEcas();
}

export function getEcaById(id: string): EcaConfig | null {
  return getEcaRegistry().getEcaById(id);
}

export function getDefaultEcaForLoginUrl(loginUrl: string): EcaConfig | null {
  return getEcaRegistry().getDefaultEcaForLoginUrl(loginUrl);
}

export function getLegacyConsumerSecret(): string | null {
  return getEcaRegistry().getLegacyConsumerSecret();
}
```

- [ ] **Step 4: Re-export from the package barrel**

Modify `libs/api-config/src/index.ts` — append:

```typescript
export * from './lib/eca-registry';
```

(If the index re-exports specific symbols only, add the registry exports explicitly: `export { getEcaRegistry, getEcas, getEcaById, getDefaultEcaForLoginUrl, getLegacyConsumerSecret, loadEcaRegistry, type EcaConfig, type EcaPublic, type EcaRegistry } from './lib/eca-registry';`)

- [ ] **Step 5: Run tests to verify they pass**

Run: `nx test api-config --testPathPattern=eca-registry`
Expected: PASS — all tests green.

- [ ] **Step 6: Run prettier**

Run: `npx prettier --write libs/api-config/src/lib/eca-registry.ts libs/api-config/src/lib/__tests__/eca-registry.spec.ts libs/api-config/src/index.ts`

- [ ] **Step 7: Commit**

```bash
git add libs/api-config/src/lib/eca-registry.ts libs/api-config/src/lib/__tests__/eca-registry.spec.ts libs/api-config/src/index.ts
git commit -m "feat(api-config): add EcaRegistry for multi-ECA Salesforce credentials

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Make legacy SFDC env vars optional and add SFDC_LEGACY_CONSUMER_SECRET

**Files:**
- Modify: `libs/api-config/src/lib/env-config.ts:205-208`

The registry now owns reading these. Zod should not require them at process boot — failure modes (no ECAs configured, mixed configs) are surfaced by the registry instead.

- [ ] **Step 1: Loosen the Zod schema**

In `libs/api-config/src/lib/env-config.ts`, change lines 205-208 from:

```typescript
SFDC_API_VERSION: z.string().regex(/^[0-9]{2,4}\.[0-9]$/),
SFDC_CONSUMER_SECRET: z.string().min(1),
SFDC_CONSUMER_KEY: z.string().min(1),
SFDC_CALLBACK_URL: z.url(),
```

to:

```typescript
SFDC_API_VERSION: z.string().regex(/^[0-9]{2,4}\.[0-9]$/),
// Legacy single-ECA back-compat shim. Prefer SFDC_ECA_N_* vars; see eca-registry.ts.
SFDC_CONSUMER_SECRET: z.string().optional().default(''),
SFDC_CONSUMER_KEY: z.string().optional().default(''),
// Used only to decrypt legacy v1-encrypted access tokens. Set to the SFDC_CONSUMER_SECRET
// value that was active when those tokens were written.
SFDC_LEGACY_CONSUMER_SECRET: z.string().optional().default(''),
SFDC_CALLBACK_URL: z.url(),
```

- [ ] **Step 2: Initialize the registry at server boot**

In the same file, find the bottom where `ENV` is constructed/exported. Add after `ENV` is finalized:

```typescript
// Validate ECA registry at startup so misconfiguration fails fast.
import { getEcaRegistry } from './eca-registry';
getEcaRegistry();
```

If `env-config.ts` already has all imports at the top, move that import up and add `getEcaRegistry();` as a side-effecting line near the bottom of the module.

- [ ] **Step 3: Run env-config tests**

Run: `nx test api-config`
Expected: PASS — existing tests still pass; the legacy fields no longer fail when absent.

- [ ] **Step 4: Run prettier**

Run: `npx prettier --write libs/api-config/src/lib/env-config.ts`

- [ ] **Step 5: Commit**

```bash
git add libs/api-config/src/lib/env-config.ts
git commit -m "feat(api-config): make SFDC_CONSUMER_KEY/SECRET optional, add SFDC_LEGACY_CONSUMER_SECRET

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add ecaId column to SalesforceOrg

**Files:**
- Modify: `prisma/schema.prisma:534-577`
- Generated by Prisma CLI: a new migration under `prisma/migrations/`

CLAUDE.md: never create migration files manually; always use the Prisma CLI. Per CLAUDE.md, run `yarn db:generate` to regenerate the Prisma client after a schema change.

- [ ] **Step 1: Add the column to the model**

In `prisma/schema.prisma`, inside `model SalesforceOrg { ... }` (around line 567 — after `lastActivityAt`), add:

```prisma
  ecaId                          String?                @db.VarChar
```

- [ ] **Step 2: Create the migration via the CLI**

Run: `yarn prisma migrate dev --name add_eca_id_to_salesforce_org --create-only`
Expected: a new directory `prisma/migrations/<timestamp>_add_eca_id_to_salesforce_org/` containing `migration.sql` with `ALTER TABLE "salesforce_org" ADD COLUMN "ecaId" VARCHAR;`.

If the dev DB is unavailable, run `yarn prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma --script` and manually create the migration directory using the Prisma CLI's documented format. **Never** hand-write a migration outside of the CLI.

- [ ] **Step 3: Apply the migration locally**

Run: `yarn prisma migrate dev`
Expected: migration applied; Prisma client regenerated.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `yarn db:generate`
Expected: regenerated client in `libs/prisma/src/lib/generated/prisma`.

- [ ] **Step 5: Type-check**

Run: `nx run api:tsc --skip-nx-cache` (or `npx tsc --noEmit -p apps/api/tsconfig.app.json` if no `tsc` target exists)
Expected: no type errors. The new field is optional, so existing code continues to compile.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add ecaId column to SalesforceOrg

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire ECA selection through OAuth init

**Files:**
- Modify: `apps/api/src/app/controllers/oauth.controller.ts:22-72`
- Test: `apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts` (create if absent)

- [ ] **Step 1: Write failing tests for OAuth init**

Create `apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts` (or extend it). Use Vitest with mocked `EcaRegistry` and `oauthService`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@jetstream/api-config', async () => {
  const actual = await vi.importActual<typeof import('@jetstream/api-config')>('@jetstream/api-config');
  return {
    ...actual,
    ENV: {
      ...actual.ENV,
      SFDC_CALLBACK_URL: 'https://example.test/cb',
      JETSTREAM_CLIENT_URL: 'https://example.test',
      LOG_LEVEL: 'silent',
      SFDC_API_VERSION: '63.0',
    },
    getEcaById: vi.fn(),
    getDefaultEcaForLoginUrl: vi.fn(),
  };
});

vi.mock('@jetstream/salesforce-oauth', () => ({
  salesforceOauthInit: vi.fn(async () => ({
    authorizationUrl: new URL('https://salesforce.test/auth'),
    code_verifier: 'cv',
    nonce: 'nonce',
    state: 'state',
  })),
  salesforceOauthCallback: vi.fn(),
}));

import * as apiConfig from '@jetstream/api-config';
import * as oauthService from '@jetstream/salesforce-oauth';
import { routeDefinition } from '../oauth.controller';

const FAKE_ECA = { id: 'prod', label: 'Production', key: 'k1', secret: 's1', defaultFor: ['https://login.salesforce.com'] };

function makeReq(query: Record<string, string>) {
  return { session: {}, log: { info: vi.fn(), warn: vi.fn() }, query } as any;
}

function makeRes() {
  return { redirect: vi.fn(), locals: {}, log: { info: vi.fn() } } as any;
}

describe('salesforceOauthInitAuth', () => {
  beforeEach(() => {
    vi.mocked(apiConfig.getEcaById).mockReset();
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReset();
    vi.mocked(oauthService.salesforceOauthInit).mockClear();
  });

  it('uses the ECA matching the supplied ecaId query param', async () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(FAKE_ECA);
    const req = makeReq({ loginUrl: 'https://login.salesforce.com', ecaId: 'prod' });
    const res = makeRes();
    const handler = routeDefinition.salesforceOauthInitAuth.controllerFn();
    await handler(req, res, vi.fn());
    expect(apiConfig.getEcaById).toHaveBeenCalledWith('prod');
    expect(vi.mocked(oauthService.salesforceOauthInit).mock.calls[0][0]).toMatchObject({
      clientId: 'k1',
      clientSecret: 's1',
    });
    expect(req.session.orgAuth.ecaId).toBe('prod');
  });

  it('falls back to the loginUrl-default ECA when no ecaId is given', async () => {
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReturnValue(FAKE_ECA);
    const req = makeReq({ loginUrl: 'https://login.salesforce.com' });
    const res = makeRes();
    const handler = routeDefinition.salesforceOauthInitAuth.controllerFn();
    await handler(req, res, vi.fn());
    expect(apiConfig.getDefaultEcaForLoginUrl).toHaveBeenCalledWith('https://login.salesforce.com');
    expect(req.session.orgAuth.ecaId).toBe('prod');
  });

  it('400s when the supplied ecaId does not exist', async () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(null);
    const req = makeReq({ loginUrl: 'https://login.salesforce.com', ecaId: 'unknown' });
    const res = makeRes();
    res.status = vi.fn().mockReturnThis();
    res.json = vi.fn();
    const handler = routeDefinition.salesforceOauthInitAuth.controllerFn();
    await expect(handler(req, res, vi.fn())).rejects.toThrow(/unknown ecaId/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nx test api --testPathPattern=oauth.controller`
Expected: FAIL — controller doesn't yet accept `ecaId` or call `getEcaById`/`getDefaultEcaForLoginUrl`.

- [ ] **Step 3: Update the route validator and controller**

In `apps/api/src/app/controllers/oauth.controller.ts`:

a) Add the registry import near the top:

```typescript
import { ENV, getEcaById, getDefaultEcaForLoginUrl, getExceptionLog, logger } from '@jetstream/api-config';
```

b) In `routeDefinition.salesforceOauthInitAuth.validators.query`, add `ecaId`:

```typescript
query: z.object({
  loginUrl: z.union([
    z.literal('https://login.salesforce.com'),
    z.literal('https://test.salesforce.com'),
    z.literal('https://welcome.salesforce.com'),
    z.literal('https://prerellogin.pre.salesforce.com'),
    z.string().regex(/^https:\/\/[a-zA-Z0-9.-]+\.my\.salesforce\.com$/),
  ]),
  ecaId: z.string().optional(),
  addLoginParam: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => val === 'true'),
  loginHint: z.string().optional(),
  orgGroupId: z.string().optional(),
  jetstreamOrganizationId: z.string().optional(),
}),
```

c) Replace the body of `salesforceOauthInitAuth` (lines 60-72) with:

```typescript
const salesforceOauthInitAuth = createRoute(routeDefinition.salesforceOauthInitAuth.validators, async ({ query }, req, res) => {
  const { loginUrl, ecaId, addLoginParam, loginHint, jetstreamOrganizationId, orgGroupId } = query;

  const eca = ecaId ? getEcaById(ecaId) : getDefaultEcaForLoginUrl(loginUrl);
  if (!eca) {
    throw new Error(`Unknown ecaId: ${ecaId ?? '(none)'}`);
  }

  const { authorizationUrl, code_verifier, nonce, state } = await oauthService.salesforceOauthInit({
    clientId: eca.key,
    clientSecret: eca.secret,
    redirectUri: ENV.SFDC_CALLBACK_URL,
    loginUrl,
    addLoginParam,
    loginHint,
  });
  req.session.orgAuth = {
    code_verifier,
    nonce,
    state,
    loginUrl,
    orgGroupId: orgGroupId || jetstreamOrganizationId,
    ecaId: eca.id,
  };
  res.redirect(authorizationUrl.toString());
});
```

d) Extend the session type. Find the existing `req.session.orgAuth` type declaration (likely in an Express session augmentation file under `apps/api/src/`). Search:

```bash
grep -rn "orgAuth" apps/api/src/ libs/api-config/src/ libs/auth/
```

Add `ecaId: string;` to the type. If declared inline, change:

```typescript
declare module 'express-session' {
  interface SessionData {
    orgAuth?: { code_verifier: string; nonce: string; state: string; loginUrl: string; orgGroupId?: string };
  }
}
```

to include `ecaId`:

```typescript
declare module 'express-session' {
  interface SessionData {
    orgAuth?: { code_verifier: string; nonce: string; state: string; loginUrl: string; orgGroupId?: string; ecaId: string };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nx test api --testPathPattern=oauth.controller`
Expected: PASS — init resolves and persists `ecaId`.

- [ ] **Step 5: Run prettier**

Run: `npx prettier --write apps/api/src/app/controllers/oauth.controller.ts apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app/controllers/oauth.controller.ts apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts
# include any session type augmentation file you found in step 3d
git commit -m "feat(api): resolve ECA in salesforceOauthInitAuth

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire ECA into OAuth callback and persist on SalesforceOrg

**Files:**
- Modify: `apps/api/src/app/controllers/oauth.controller.ts:79-247`
- Modify: `apps/api/src/app/db/salesforce-org.db.ts:114` (the `createOrUpdateSalesforceOrg` signature accepts `Partial<SalesforceOrgUi>`; the field is added by Prisma client regen, but verify the type extension)
- Modify: `libs/types/src/lib/types.ts` if `SalesforceOrgUi` does not yet have `ecaId?: string`
- Test: `apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts`

- [ ] **Step 1: Add `ecaId` to the `SalesforceOrgUi` type**

Run: `grep -n "interface SalesforceOrgUi\|type SalesforceOrgUi" libs/types/src/`

Find the type (likely in `libs/types/src/lib/types.ts`). Add `ecaId?: string;` alongside fields like `loginUrl`. Example:

```typescript
export interface SalesforceOrgUi {
  // ...existing fields
  loginUrl: string;
  ecaId?: string;
  // ...
}
```

- [ ] **Step 2: Write failing test for the callback**

Append to `apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts`:

```typescript
describe('salesforceOauthCallback', () => {
  beforeEach(() => {
    vi.mocked(apiConfig.getEcaById).mockReset();
  });

  it('errors when the session-stored ecaId no longer maps to a configured ECA', async () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(null);
    const req = {
      session: { orgAuth: { code_verifier: 'cv', nonce: 'n', state: 's', loginUrl: 'https://login.salesforce.com', ecaId: 'gone' } },
      log: { info: vi.fn() },
      query: { code: 'abc' },
    } as any;
    const res = makeRes();
    const handler = routeDefinition.salesforceOauthCallback.controllerFn();
    await handler(req, res, vi.fn());
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error='));
  });

  it('passes ecaId to initConnectionFromOAuthResponse on success', async () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(FAKE_ECA);
    vi.mocked(oauthService.salesforceOauthCallback).mockResolvedValue({
      access_token: 'at',
      refresh_token: 'rt',
      userInfo: { user_id: 'u', organization_id: 'o', urls: {} },
    } as any);
    // Stub initConnectionFromOAuthResponse via module-mock or a factory hook.
    // (Implementation note: the existing controller calls a top-level helper. The test should
    // mock that helper and assert it received { ecaId: 'prod' }.)
  });
});
```

> Note: the second assertion depends on how `initConnectionFromOAuthResponse` is mocked. If the controller imports it from the same module, refactor that helper into a thin wrapper around `salesforceOrgsDb.createOrUpdateSalesforceOrg` so the test can spy on the DB call instead. See step 4.

- [ ] **Step 3: Run tests to verify they fail**

Run: `nx test api --testPathPattern=oauth.controller`
Expected: FAIL — callback does not yet check ECA and does not pass `ecaId`.

- [ ] **Step 4: Update the callback**

In `apps/api/src/app/controllers/oauth.controller.ts`:

a) Inside `salesforceOauthCallback`, after destructuring `orgAuth`, resolve the ECA:

```typescript
const { code_verifier, nonce, state, loginUrl, orgGroupId, ecaId } = orgAuth;
const eca = getEcaById(ecaId);
if (!eca) {
  returnParams.error = 'Authentication Error';
  returnParams.message = `The connected app (${ecaId}) is no longer configured. Reconnect using a current connected app.`;
  req.log.info({ ecaId, requestId: res.locals.requestId }, '[OAUTH][ERROR] ECA from session no longer exists');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.redirect(`/oauth-link/?${new URLSearchParams(returnParams as any).toString().replaceAll('+', '%20')}`);
}
```

b) Replace the `clientId`/`clientSecret` arguments to `oauthService.salesforceOauthCallback` with `eca.key` / `eca.secret` (lines 115-116).

c) Pass `ecaId: eca.id` into `initConnectionFromOAuthResponse`:

```typescript
const salesforceOrg = await initConnectionFromOAuthResponse({
  jetstreamConn,
  userId: user.id,
  orgGroupId,
  ecaId: eca.id,
});
```

d) Update `initConnectionFromOAuthResponse` (line 178) to accept and persist `ecaId`:

```typescript
export async function initConnectionFromOAuthResponse({
  jetstreamConn,
  userId,
  orgGroupId,
  ecaId,
}: {
  jetstreamConn: ApiConnection;
  userId: string;
  orgGroupId?: Maybe<string>;
  ecaId: string;
}) {
  // ...existing body...
  const salesforceOrgUi: Partial<SalesforceOrgUi> = {
    // ...existing fields
    ecaId,
    // ...remaining fields
  };
  // ...
}
```

- [ ] **Step 5: Update the DB layer to persist `ecaId`**

Open `apps/api/src/app/db/salesforce-org.db.ts`. Find `createOrUpdateSalesforceOrg` (line 114). Confirm it spreads `salesforceOrgUi` into a Prisma `data` argument; if it explicitly lists fields, add `ecaId: salesforceOrgUi.ecaId` to both create and update branches. The Prisma client regenerated in Task 3 already accepts the field on the input type.

- [ ] **Step 6: Run tests to verify they pass**

Run: `nx test api --testPathPattern=oauth.controller`
Expected: PASS.

- [ ] **Step 7: Run prettier**

Run: `npx prettier --write apps/api/src/app/controllers/oauth.controller.ts apps/api/src/app/db/salesforce-org.db.ts libs/types/src/lib/types.ts`

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/app/controllers/oauth.controller.ts apps/api/src/app/controllers/__tests__/oauth.controller.spec.ts apps/api/src/app/db/salesforce-org.db.ts libs/types/src/lib/types.ts
git commit -m "feat(api): persist ecaId on SalesforceOrg via OAuth callback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Resolve ECA at token-refresh time in route middleware

**Files:**
- Modify: `apps/api/src/app/routes/route.middleware.ts:410-427`
- Test: `apps/api/src/app/routes/__tests__/route.middleware.spec.ts` (create if absent)

- [ ] **Step 1: Write failing tests for refresh-time ECA resolution**

Create or extend `apps/api/src/app/routes/__tests__/route.middleware.spec.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@jetstream/api-config', async () => {
  const actual = await vi.importActual<typeof import('@jetstream/api-config')>('@jetstream/api-config');
  return {
    ...actual,
    getEcaById: vi.fn(),
    getDefaultEcaForLoginUrl: vi.fn(),
    ENV: { ...actual.ENV, LOG_LEVEL: 'silent', SFDC_API_VERSION: '63.0' },
  };
});

vi.mock('@jetstream/salesforce-api', () => ({
  ApiConnection: vi.fn(),
  getApiRequestFactoryFn: vi.fn(),
  ApiRequestError: class {},
}));

import * as apiConfig from '@jetstream/api-config';
import { ApiConnection } from '@jetstream/salesforce-api';
import { resolveEcaForOrg } from '../route.middleware'; // we will export this for testing

const ECA_PROD = { id: 'prod', label: 'Prod', key: 'k1', secret: 's1', defaultFor: ['https://login.salesforce.com'] };
const ECA_FALLBACK = { id: 'ncinodev', label: 'nCino', key: 'k2', secret: 's2', defaultFor: ['https://test.salesforce.com'] };

describe('resolveEcaForOrg', () => {
  beforeEach(() => {
    vi.mocked(apiConfig.getEcaById).mockReset();
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReset();
  });

  it('uses the persisted ecaId when present and valid', () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(ECA_PROD);
    const eca = resolveEcaForOrg({ ecaId: 'prod', loginUrl: 'https://login.salesforce.com' });
    expect(eca?.key).toBe('k1');
    expect(apiConfig.getDefaultEcaForLoginUrl).not.toHaveBeenCalled();
  });

  it('falls back to loginUrl default when persisted ecaId is unknown', () => {
    vi.mocked(apiConfig.getEcaById).mockReturnValue(null);
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReturnValue(ECA_FALLBACK);
    const logger = { warn: vi.fn() };
    const eca = resolveEcaForOrg({ ecaId: 'gone', loginUrl: 'https://test.salesforce.com' }, logger as any);
    expect(eca?.key).toBe('k2');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ ecaId: 'gone' }), expect.any(String));
  });

  it('uses loginUrl default when no ecaId is persisted (legacy rows)', () => {
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReturnValue(ECA_FALLBACK);
    const eca = resolveEcaForOrg({ ecaId: null, loginUrl: 'https://test.salesforce.com' });
    expect(eca?.key).toBe('k2');
  });

  it('returns null when neither persisted nor default ECA resolves', () => {
    vi.mocked(apiConfig.getDefaultEcaForLoginUrl).mockReturnValue(null);
    const eca = resolveEcaForOrg({ ecaId: null, loginUrl: 'https://login.salesforce.com' });
    expect(eca).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nx test api --testPathPattern=route.middleware`
Expected: FAIL — `resolveEcaForOrg` is not exported.

- [ ] **Step 3: Add the resolver and replace the inline ENV reads**

In `apps/api/src/app/routes/route.middleware.ts`:

a) Add the registry import:

```typescript
import { getEcaById, getDefaultEcaForLoginUrl, type EcaConfig } from '@jetstream/api-config';
```

b) Export a small helper near the top of the file (above the existing connection-building code):

```typescript
export function resolveEcaForOrg(
  org: { ecaId: string | null; loginUrl: string },
  logger?: { warn: (obj: object, msg: string) => void },
): EcaConfig | null {
  if (org.ecaId) {
    const eca = getEcaById(org.ecaId);
    if (eca) {
      return eca;
    }
    logger?.warn(
      { ecaId: org.ecaId, loginUrl: org.loginUrl },
      '[ORG][ECA] Persisted ecaId not found in registry; falling back to loginUrl default',
    );
  }
  return getDefaultEcaForLoginUrl(org.loginUrl);
}
```

c) Replace lines 410-427. Locate the `new ApiConnection({ ... sfdcClientId: ENV.SFDC_CONSUMER_KEY, sfdcClientSecret: ENV.SFDC_CONSUMER_SECRET, ... })` call. Before constructing it:

```typescript
const eca = resolveEcaForOrg({ ecaId: org.ecaId ?? null, loginUrl: org.loginUrl }, logger);
if (!eca) {
  throw new Error(`No ECA available for org ${org.uniqueId} (loginUrl=${org.loginUrl})`);
}
```

Then change `sfdcClientId` / `sfdcClientSecret` to:

```typescript
sfdcClientId: eca.key,
sfdcClientSecret: eca.secret,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nx test api --testPathPattern=route.middleware`
Expected: PASS.

- [ ] **Step 5: Run prettier**

Run: `npx prettier --write apps/api/src/app/routes/route.middleware.ts apps/api/src/app/routes/__tests__/route.middleware.spec.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app/routes/route.middleware.ts apps/api/src/app/routes/__tests__/route.middleware.spec.ts
git commit -m "feat(api): resolve ECA per-org at token-refresh time

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Decouple legacy v1 token decryption from active ECA list

**Files:**
- Modify: `apps/api/src/app/services/salesforce-org-encryption.service.ts:1-150`
- Test: `apps/api/src/app/services/__tests__/salesforce-org-encryption.service.spec.ts` (create if absent)

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/app/services/__tests__/salesforce-org-encryption.service.spec.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@jetstream/api-config', async () => {
  const actual = await vi.importActual<typeof import('@jetstream/api-config')>('@jetstream/api-config');
  return {
    ...actual,
    getLegacyConsumerSecret: vi.fn(),
    ENV: {
      ...actual.ENV,
      SFDC_ENCRYPTION_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
      SFDC_ENCRYPTION_ITERATIONS: 10000,
      SFDC_ENCRYPTION_CACHE_MAX_ENTRIES: 10,
      SFDC_ENCRYPTION_CACHE_TTL_MS: 1000,
    },
  };
});

vi.mock('@jetstream/shared/node-utils', () => ({
  encryptString: vi.fn((data: string, key: string) => `enc(${data}|${key})`),
  decryptString: vi.fn((data: string, key: string) => {
    if (data.startsWith('legacy|') && key === 'legacy-base64') {
      return data.slice('legacy|'.length);
    }
    if (data === 'mismatch') {
      throw new Error('decrypt failed');
    }
    return data;
  }),
  hexToBase64: vi.fn((hex: string) => `${hex}-base64`),
}));

import * as apiConfig from '@jetstream/api-config';
import { decryptAccessToken, DUMMY_INVALID_ENCRYPTED_TOKEN } from '../salesforce-org-encryption.service';

describe('decryptAccessToken (v1 legacy path)', () => {
  beforeEach(() => {
    vi.mocked(apiConfig.getLegacyConsumerSecret).mockReset();
  });

  it('decrypts using SFDC_LEGACY_CONSUMER_SECRET when present', async () => {
    vi.mocked(apiConfig.getLegacyConsumerSecret).mockReturnValue('legacy');
    const [access, refresh] = await decryptAccessToken({
      encryptedAccessToken: 'legacy|access refresh',
      userId: 'u',
    });
    expect(access).toBe('access');
    expect(refresh).toBe('refresh');
  });

  it('returns DUMMY_INVALID_ENCRYPTED_TOKEN when SFDC_LEGACY_CONSUMER_SECRET is unset', async () => {
    vi.mocked(apiConfig.getLegacyConsumerSecret).mockReturnValue(null);
    const [access, refresh] = await decryptAccessToken({
      encryptedAccessToken: 'mismatch',
      userId: 'u',
    });
    expect(access).toBe(DUMMY_INVALID_ENCRYPTED_TOKEN);
    expect(refresh).toBe(DUMMY_INVALID_ENCRYPTED_TOKEN);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nx test api --testPathPattern=salesforce-org-encryption`
Expected: FAIL — service still reads `ENV.SFDC_CONSUMER_SECRET` directly.

- [ ] **Step 3: Update the service**

In `apps/api/src/app/services/salesforce-org-encryption.service.ts`:

a) Update imports (line 1):

```typescript
import { ENV, getExceptionLog, getLegacyConsumerSecret, logger, rollbarServer } from '@jetstream/api-config';
```

b) Replace line 133 (legacy decrypt branch):

```typescript
// Legacy format - decrypt with old method
try {
  const legacySecret = getLegacyConsumerSecret();
  if (!legacySecret) {
    throw new Error('Legacy consumer secret not configured (SFDC_LEGACY_CONSUMER_SECRET)');
  }
  const decrypted = decryptString(encryptedAccessToken, hexToBase64(legacySecret));
  const [accessToken, refreshToken] = decrypted.split(' ');
  return [accessToken, refreshToken];
} catch (error) {
  logger.error('Failed to decrypt token, it may be corrupted', error);
  throw new Error('Unable to decrypt access token');
}
```

c) Update the comment block at line 25-27:

```typescript
/**
 * Encryption versions
 * - v1: Legacy encryption using SFDC_LEGACY_CONSUMER_SECRET (or the original SFDC_CONSUMER_SECRET if running in back-compat mode)
 * - v2: Per-user encryption with derived keys
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nx test api --testPathPattern=salesforce-org-encryption`
Expected: PASS.

- [ ] **Step 5: Run prettier**

Run: `npx prettier --write apps/api/src/app/services/salesforce-org-encryption.service.ts apps/api/src/app/services/__tests__/salesforce-org-encryption.service.spec.ts`

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app/services/salesforce-org-encryption.service.ts apps/api/src/app/services/__tests__/salesforce-org-encryption.service.spec.ts
git commit -m "feat(api): decouple v1 token decryption from active ECA list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Add GET /api/salesforce/ecas endpoint

**Files:**
- Create: `apps/api/src/app/controllers/salesforce-eca.controller.ts`
- Create: `apps/api/src/app/controllers/__tests__/salesforce-eca.controller.spec.ts`
- Modify: an existing routes file that mounts API controllers under `/api/salesforce` (search to confirm path).

- [ ] **Step 1: Find the mount point**

Run:

```bash
grep -rn "/api/salesforce\|salesforce.routes" apps/api/src/app/routes/ | head
```

Identify the routes file where Salesforce-scoped GETs live (often `salesforce.routes.ts` or `api.routes.ts`). Use that file in step 4.

- [ ] **Step 2: Write failing test**

Create `apps/api/src/app/controllers/__tests__/salesforce-eca.controller.spec.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

vi.mock('@jetstream/api-config', async () => {
  const actual = await vi.importActual<typeof import('@jetstream/api-config')>('@jetstream/api-config');
  return {
    ...actual,
    getEcas: vi.fn(),
  };
});

import * as apiConfig from '@jetstream/api-config';
import { routeDefinition } from '../salesforce-eca.controller';

describe('listEcas', () => {
  it('returns id/label/defaultFor only, never key/secret', async () => {
    vi.mocked(apiConfig.getEcas).mockReturnValue([
      { id: 'prod', label: 'Production', key: 'SECRET-KEY', secret: 'SECRET', defaultFor: ['https://login.salesforce.com'] },
      { id: 'ncinodev', label: 'nCino Dev', key: 'K2', secret: 'S2', defaultFor: ['https://test.salesforce.com'] },
    ]);

    const handler = routeDefinition.listEcas.controllerFn();
    const res: any = { json: vi.fn(), locals: {}, log: { info: vi.fn() } };
    await handler({ session: {}, log: { info: vi.fn() } } as any, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      ecas: [
        { id: 'prod', label: 'Production', defaultFor: ['https://login.salesforce.com'] },
        { id: 'ncinodev', label: 'nCino Dev', defaultFor: ['https://test.salesforce.com'] },
      ],
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `nx test api --testPathPattern=salesforce-eca.controller`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the controller**

Create `apps/api/src/app/controllers/salesforce-eca.controller.ts`:

```typescript
import { getEcas } from '@jetstream/api-config';
import { z } from 'zod';
import { createRoute, RouteValidator } from '../utils/route.utils';

export const routeDefinition = {
  listEcas: {
    controllerFn: () => listEcas,
    validators: {
      query: z.object({}),
      hasSourceOrg: false,
    } satisfies RouteValidator,
  },
};

const listEcas = createRoute(routeDefinition.listEcas.validators, async (_, _req, res) => {
  const ecas = getEcas().map(({ id, label, defaultFor }) => ({ id, label, defaultFor }));
  res.json({ ecas });
});
```

- [ ] **Step 5: Wire the route**

In the routes file you found in step 1, add:

```typescript
import { routeDefinition as salesforceEcaController } from '../controllers/salesforce-eca.controller';
// ...
routes.get('/salesforce/ecas', checkAuth, salesforceEcaController.listEcas.controllerFn());
```

(Use whatever middleware pattern the surrounding routes use — e.g. `checkAuth`, `requireAuth`. Match the convention.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `nx test api --testPathPattern=salesforce-eca.controller`
Expected: PASS.

- [ ] **Step 7: Run prettier**

Run: `npx prettier --write apps/api/src/app/controllers/salesforce-eca.controller.ts apps/api/src/app/controllers/__tests__/salesforce-eca.controller.spec.ts`

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/app/controllers/salesforce-eca.controller.ts apps/api/src/app/controllers/__tests__/salesforce-eca.controller.spec.ts apps/api/src/app/routes/
git commit -m "feat(api): add GET /api/salesforce/ecas endpoint

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Update AddOrgHandlerFn type and addOrg helper to pass ecaId

**Files:**
- Modify: `libs/types/src/lib/types.ts:425-428`
- Modify: `libs/shared/ui-utils/src/lib/shared-ui-utils.ts:954-973`

- [ ] **Step 1: Extend the handler type**

In `libs/types/src/lib/types.ts:425-428`, change:

```typescript
export type AddOrgHandlerFn = (
  options: { serverUrl: string; loginUrl: string; addLoginTrue?: boolean; orgGroupId?: Maybe<string>; loginHint?: string },
  callback: (org: SalesforceOrgUi) => void,
) => void;
```

to:

```typescript
export type AddOrgHandlerFn = (
  options: {
    serverUrl: string;
    loginUrl: string;
    ecaId?: string;
    addLoginTrue?: boolean;
    orgGroupId?: Maybe<string>;
    loginHint?: string;
  },
  callback: (org: SalesforceOrgUi) => void,
) => void;
```

- [ ] **Step 2: Forward ecaId in addOrg**

In `libs/shared/ui-utils/src/lib/shared-ui-utils.ts:954-973`, change:

```typescript
export const addOrg: AddOrgHandlerFn = (options, callback) => {
  const { serverUrl, loginUrl, addLoginTrue, orgGroupId, loginHint } = options;
  // ...
  if (loginHint) {
    url.searchParams.set('loginHint', loginHint);
  }
  if (addLoginTrue) {
    url.searchParams.set('addLoginParam', 'true');
  }
  if (orgGroupId) {
    url.searchParams.set('orgGroupId', orgGroupId);
  }
```

to also include `ecaId`:

```typescript
export const addOrg: AddOrgHandlerFn = (options, callback) => {
  const { serverUrl, loginUrl, ecaId, addLoginTrue, orgGroupId, loginHint } = options;
  // ...existing setup...
  if (ecaId) {
    url.searchParams.set('ecaId', ecaId);
  }
  if (loginHint) {
    url.searchParams.set('loginHint', loginHint);
  }
  if (addLoginTrue) {
    url.searchParams.set('addLoginParam', 'true');
  }
  if (orgGroupId) {
    url.searchParams.set('orgGroupId', orgGroupId);
  }
```

- [ ] **Step 3: Run prettier**

Run: `npx prettier --write libs/types/src/lib/types.ts libs/shared/ui-utils/src/lib/shared-ui-utils.ts`

- [ ] **Step 4: Type-check**

Run: `nx run-many -t tsc --skip-nx-cache --projects=types,shared-ui-utils`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add libs/types/src/lib/types.ts libs/shared/ui-utils/src/lib/shared-ui-utils.ts
git commit -m "feat(types,ui-utils): thread ecaId through AddOrgHandlerFn

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Add ECA dropdown to AddOrg UI

**Files:**
- Modify: `libs/shared/ui-core/src/orgs/AddOrg.tsx`
- Test: `libs/shared/ui-core/src/orgs/__tests__/AddOrg.spec.tsx`

- [ ] **Step 1: Write failing test**

Create `libs/shared/ui-core/src/orgs/__tests__/AddOrg.spec.tsx`:

```typescript
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AddOrg } from '../AddOrg';

const mockEcas = [
  { id: 'prod', label: 'Production', defaultFor: ['https://login.salesforce.com'] },
  { id: 'ncinodev', label: 'nCino Dev', defaultFor: ['https://test.salesforce.com'] },
  { id: 'partialdev', label: 'Partial Dev', defaultFor: [] },
];

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ecas: mockEcas }) }) as any);
});

describe('AddOrg ECA dropdown', () => {
  it('defaults to the ECA whose defaultFor includes the current loginUrl', async () => {
    const onAddOrg = vi.fn();
    const onAddOrgHandlerFn = vi.fn();
    render(<AddOrg onAddOrg={onAddOrg} onAddOrgHandlerFn={onAddOrgHandlerFn} />);
    fireEvent.click(screen.getByRole('button', { name: /add org/i }));
    await waitFor(() => screen.getByLabelText(/connected app/i));
    expect((screen.getByLabelText(/connected app/i) as HTMLSelectElement).value).toBe('prod');
    fireEvent.click(screen.getByLabelText(/sandbox/i));
    await waitFor(() => expect((screen.getByLabelText(/connected app/i) as HTMLSelectElement).value).toBe('ncinodev'));
  });

  it('preserves a manual override when the org type changes if still valid', async () => {
    render(<AddOrg onAddOrg={vi.fn()} onAddOrgHandlerFn={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add org/i }));
    await waitFor(() => screen.getByLabelText(/connected app/i));
    fireEvent.change(screen.getByLabelText(/connected app/i), { target: { value: 'partialdev' } });
    fireEvent.click(screen.getByLabelText(/sandbox/i));
    await waitFor(() => expect((screen.getByLabelText(/connected app/i) as HTMLSelectElement).value).toBe('partialdev'));
  });

  it('passes the chosen ecaId to onAddOrgHandlerFn on submit', async () => {
    const handler = vi.fn();
    render(<AddOrg onAddOrg={vi.fn()} onAddOrgHandlerFn={handler} />);
    fireEvent.click(screen.getByRole('button', { name: /add org/i }));
    await waitFor(() => screen.getByLabelText(/connected app/i));
    fireEvent.change(screen.getByLabelText(/connected app/i), { target: { value: 'ncinodev' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ ecaId: 'ncinodev' }), expect.any(Function));
  });

  it('disables the dropdown when only one ECA is configured', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ecas: [mockEcas[0]] }) }) as any);
    render(<AddOrg onAddOrg={vi.fn()} onAddOrgHandlerFn={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add org/i }));
    await waitFor(() => screen.getByLabelText(/connected app/i));
    expect((screen.getByLabelText(/connected app/i) as HTMLSelectElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nx test ui-core --testPathPattern=AddOrg`
Expected: FAIL — no dropdown rendered, no fetch.

- [ ] **Step 3: Add the dropdown to AddOrg.tsx**

In `libs/shared/ui-core/src/orgs/AddOrg.tsx`, make these changes:

a) Add new state and a fetch effect alongside the existing state hooks (after line 71):

```typescript
type EcaPublic = { id: string; label: string; defaultFor: string[] };

const [ecas, setEcas] = useState<EcaPublic[]>([]);
const [ecaId, setEcaId] = useState<string | null>(null);
const [ecaUserOverridden, setEcaUserOverridden] = useState(false);

useEffect(() => {
  let cancelled = false;
  fetch(`${applicationState.serverUrl}/api/salesforce/ecas`, { credentials: 'include' })
    .then((response) => response.json())
    .then((data: { ecas: EcaPublic[] }) => {
      if (!cancelled) {
        setEcas(data.ecas);
      }
    })
    .catch(() => {
      // Endpoint unavailable; AddOrg falls back to server-side default ECA.
    });
  return () => {
    cancelled = true;
  };
}, [applicationState.serverUrl]);
```

b) Add a default-snapping effect that respects user overrides:

```typescript
useEffect(() => {
  if (ecas.length === 0 || !loginUrl) {
    return;
  }
  if (ecaUserOverridden) {
    const stillValid = ecas.some((eca) => eca.id === ecaId);
    if (stillValid) {
      return;
    }
  }
  const defaultEca = ecas.find((eca) => eca.defaultFor.includes(loginUrl)) ?? ecas[0];
  setEcaId(defaultEca?.id ?? null);
}, [ecas, loginUrl, ecaId, ecaUserOverridden]);
```

c) In `handleAddOrg`, include `ecaId` in the options passed to `onAddOrgHandlerFn`:

```typescript
function handleAddOrg() {
  loginUrl &&
    onAddOrgHandlerFn(
      {
        serverUrl: applicationState.serverUrl,
        loginUrl,
        ecaId: ecaId ?? undefined,
        addLoginTrue: advancedOptionsEnabled && addLoginTrue,
        orgGroupId: addToActiveOrgGroup ? orgGroup?.id : null,
        loginHint: existingOrg?.username,
      },
      (addedOrg: SalesforceOrgUi) => {
        popoverRef.current?.close();
        onAddOrg(addedOrg, true);
      },
    );
  // ... existing trackEvent ...
}
```

d) Render the dropdown inside the `<RadioGroup>`-containing block. Add this after the org-type `<RadioGroup>` (line 158) and before the `orgType === 'custom'` block:

```tsx
<div className="slds-form-element slds-m-top_small">
  <label className="slds-form-element__label" htmlFor="org-eca-select">
    Connected App
  </label>
  <div className="slds-form-element__control">
    <div className="slds-select_container">
      <select
        id="org-eca-select"
        aria-label="Connected App"
        className="slds-select"
        value={ecaId ?? ''}
        disabled={ecas.length <= 1}
        onChange={(event) => {
          setEcaId(event.target.value);
          setEcaUserOverridden(true);
        }}
      >
        {ecas.map((eca) => (
          <option key={eca.id} value={eca.id}>
            {eca.label}
          </option>
        ))}
      </select>
    </div>
  </div>
</div>
```

e) Update `handleReset` to clear `ecaUserOverridden`:

```typescript
function handleReset() {
  if (existingOrg) {
    return;
  }
  setOrgType('prod');
  setCustomUrl('');
  setLoginUrl(loginUrlMap.prod);
  setAdvancedOptionsEnabled(false);
  setAddLoginTrue(false);
  setAddToActiveOrgGroup(true);
  setEcaUserOverridden(false);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nx test ui-core --testPathPattern=AddOrg`
Expected: PASS.

- [ ] **Step 5: Manually verify in the browser**

Per CLAUDE.md, frontend changes need a browser test:

1. Run `nx serve api` and `nx serve jetstream` (or `yarn dev`).
2. Set up `.env` with two ECAs (e.g. `SFDC_ECA_1_*` for prod, `SFDC_ECA_2_*` for sandbox).
3. Open the app, click **Add Org**, switch between Production and Sandbox radio buttons.
4. Confirm: the dropdown defaults snap correctly; selecting partialdev and switching org type preserves it; the OAuth window opens with `ecaId` in the query string.

Note in the PR description any UI quirks. If you cannot run the browser test, say so explicitly.

- [ ] **Step 6: Run prettier**

Run: `npx prettier --write libs/shared/ui-core/src/orgs/AddOrg.tsx libs/shared/ui-core/src/orgs/__tests__/AddOrg.spec.tsx`

- [ ] **Step 7: Commit**

```bash
git add libs/shared/ui-core/src/orgs/AddOrg.tsx libs/shared/ui-core/src/orgs/__tests__/AddOrg.spec.tsx
git commit -m "feat(ui-core): add Connected App dropdown to AddOrg with smart defaults

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Show ECA label on the org list when multiple ECAs configured

**Files:**
- Modify: org list rendering files (search to confirm)

- [ ] **Step 1: Find the org list rendering file**

Run:

```bash
grep -rn "SalesforceOrgUi" libs/shared/ui-core/src/orgs/ libs/shared/ui-core/src/app-shell/ 2>/dev/null | grep -E "\\.tsx" | head -20
```

Common candidates: `OrgsCombobox.tsx`, `OrgsDropdown.tsx`, `OrgInfoPopover.tsx`, `OrgPersistenceContainer.tsx`. Pick the file(s) that render an org name in the dropdown/list users see in the header.

- [ ] **Step 2: Add an `EcaPublic` lookup hook**

In `libs/shared/ui-core/src/orgs/`, create `useEcaLookup.ts` (or co-locate with the org list file if it's the only consumer):

```typescript
import { useEffect, useState } from 'react';

type EcaPublic = { id: string; label: string };

let cached: EcaPublic[] | null = null;

export function useEcaLookup(serverUrl: string): Map<string, string> {
  const [ecas, setEcas] = useState<EcaPublic[]>(cached ?? []);
  useEffect(() => {
    if (cached) {
      return;
    }
    fetch(`${serverUrl}/api/salesforce/ecas`, { credentials: 'include' })
      .then((response) => response.json())
      .then((data: { ecas: EcaPublic[] }) => {
        cached = data.ecas;
        setEcas(data.ecas);
      })
      .catch(() => {
        // Endpoint unavailable; show "Unknown connected app" for unmatched ids.
      });
  }, [serverUrl]);
  return new Map(ecas.map((eca) => [eca.id, eca.label]));
}
```

- [ ] **Step 3: Render the ECA label as a subtitle**

In the org list file from step 1, alongside the existing org name rendering, add:

```tsx
{org.ecaId && ecaLookup.size > 1 && (
  <div className="slds-text-color_weak slds-text-body_small">
    {ecaLookup.get(org.ecaId) ?? 'Unknown connected app'}
  </div>
)}
```

- [ ] **Step 4: Verify in the browser**

Reuse the browser session from Task 10. Connect orgs through two different ECAs; confirm each org card shows the correct ECA label as a subtitle. If you cannot run the browser test, say so explicitly.

- [ ] **Step 5: Run prettier**

Run: `npx prettier --write libs/shared/ui-core/src/orgs/`

- [ ] **Step 6: Commit**

```bash
git add libs/shared/ui-core/src/orgs/
git commit -m "feat(ui-core): show connected app label on org list when multiple ECAs configured

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Update setup scripts to loop-prompt for multiple ECAs

**Files:**
- Modify: `scripts/podman-setup-mac.sh:128-156`
- Modify: `scripts/generate.env.mjs:74-95`

- [ ] **Step 1: Rewrite the credentials block in podman-setup-mac.sh**

Replace lines 128-156 of `scripts/podman-setup-mac.sh` with:

```bash
# ------------------------------------------------------------------
# Step 5: Set up Salesforce credentials
# ------------------------------------------------------------------
info "Step 5/7: Setting up Salesforce credentials..."

if [ -f "$ENV_FILE" ]; then
    info "  Credentials file (.env) already exists, keeping existing values"
else
    echo ""
    echo -e "  ${BOLD}To connect Salesforce orgs, you need OAuth credentials (one ECA per Salesforce org).${NC}"
    echo -e "  Find them in the shared 1Password vault: ${BOLD}Jetstream Local Credentials${NC}"
    echo ""

    : > "$ENV_FILE"
    echo "# Salesforce External Client Apps (ECAs)" >> "$ENV_FILE"

    eca_index=1
    while true; do
        echo ""
        echo -e "  ${BOLD}ECA #${eca_index}${NC}"
        read -p "    ID (short slug, e.g. prod, ncinodev): " ECA_ID
        if [ -z "$ECA_ID" ]; then
            warn "    Skipping; you can edit .env later."
            break
        fi
        if ! [[ "$ECA_ID" =~ ^[a-z0-9-]+$ ]]; then
            warn "    Invalid id; must match ^[a-z0-9-]+$. Try again."
            continue
        fi
        read -p "    Label (e.g. Production): " ECA_LABEL
        read -p "    Consumer Key: " ECA_KEY
        read -p "    Consumer Secret: " ECA_SECRET
        echo "    Default for which org type? (optional)"
        echo "      1) Production (login.salesforce.com)"
        echo "      2) Sandbox (test.salesforce.com)"
        echo "      3) Pre-release (prerellogin.pre.salesforce.com)"
        echo "      4) None"
        read -p "    Choice [4]: " ECA_DEFAULT_CHOICE
        case "${ECA_DEFAULT_CHOICE:-4}" in
            1) ECA_DEFAULT="prod" ;;
            2) ECA_DEFAULT="sandbox" ;;
            3) ECA_DEFAULT="pre-release" ;;
            *) ECA_DEFAULT="" ;;
        esac

        cat >> "$ENV_FILE" << EOF
SFDC_ECA_${eca_index}_ID='${ECA_ID}'
SFDC_ECA_${eca_index}_LABEL='${ECA_LABEL}'
SFDC_ECA_${eca_index}_KEY='${ECA_KEY}'
SFDC_ECA_${eca_index}_SECRET='${ECA_SECRET}'
SFDC_ECA_${eca_index}_DEFAULT_FOR='${ECA_DEFAULT}'

EOF

        info "    Saved ECA #${eca_index} (${ECA_ID})"
        eca_index=$((eca_index + 1))

        read -p "  Add another ECA? (y/N) " ADD_ANOTHER
        case "$ADD_ANOTHER" in
            y|Y) continue ;;
            *) break ;;
        esac
    done

    if [ "$eca_index" -eq 1 ]; then
        warn "  No ECAs configured — adding placeholders so the app can boot."
        cat >> "$ENV_FILE" << 'EOF'
SFDC_ECA_1_ID='placeholder'
SFDC_ECA_1_LABEL='Placeholder'
SFDC_ECA_1_KEY='placeholder-get-key-from-your-team'
SFDC_ECA_1_SECRET='placeholder-get-secret-from-your-team'
SFDC_ECA_1_DEFAULT_FOR=''
EOF
    fi
fi
```

- [ ] **Step 2: Rewrite the SFDC prompt in generate.env.mjs**

In `scripts/generate.env.mjs`, replace the static documentation block (lines 74-93) with an interactive loop. Insert before `fs.writeFileSync(outputFilename, newEnvFile)` (line 95):

```javascript
const ecaLines = [];
let ecaIndex = 1;
while (true) {
  console.log(chalk.green(`\nECA #${ecaIndex}`));
  const id = (await question('  ID (short slug, e.g. prod, ncinodev) [enter to stop]: ')).trim();
  if (!id) {
    break;
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    console.log(chalk.red('  Invalid id; must match ^[a-z0-9-]+$'));
    continue;
  }
  const label = (await question('  Label (e.g. Production): ')).trim();
  const key = (await question('  Consumer Key: ')).trim();
  const secret = (await question('  Consumer Secret: ')).trim();
  console.log('  Default for which org type? (optional)');
  console.log('    1) Production (login.salesforce.com)');
  console.log('    2) Sandbox (test.salesforce.com)');
  console.log('    3) Pre-release (prerellogin.pre.salesforce.com)');
  console.log('    4) None');
  const choice = (await question('  Choice [4]: ')).trim();
  const defaultFor = { '1': 'prod', '2': 'sandbox', '3': 'pre-release' }[choice] ?? '';

  ecaLines.push(
    `SFDC_ECA_${ecaIndex}_ID='${id}'`,
    `SFDC_ECA_${ecaIndex}_LABEL='${label}'`,
    `SFDC_ECA_${ecaIndex}_KEY='${key}'`,
    `SFDC_ECA_${ecaIndex}_SECRET='${secret}'`,
    `SFDC_ECA_${ecaIndex}_DEFAULT_FOR='${defaultFor}'`,
    '',
  );
  ecaIndex++;

  const more = (await question('Add another ECA? (y/N) ')).trim().toLowerCase();
  if (more !== 'y') {
    break;
  }
}

const finalEnvFile = newEnvFile + '\n' + ecaLines.join('\n');
fs.writeFileSync(outputFilename, finalEnvFile);
```

Remove the old static documentation block (lines 74-93).

- [ ] **Step 3: Smoke-test the bash script**

Run a dry-run with a temp `.env`:

```bash
( cd /tmp && rm -f .env && \
  echo -e "prod\nProduction\nKEY1\nSECRET1\n1\nn" | bash -c 'ENV_FILE=/tmp/.env source <(sed -n "128,200p" /Users/sriganesh.gopal/Documents/jetstream/scripts/podman-setup-mac.sh)' ) || true
cat /tmp/.env
```

Expected: `/tmp/.env` contains `SFDC_ECA_1_ID='prod'` etc. (Skip if the ad-hoc invocation is awkward — at minimum, run `bash -n scripts/podman-setup-mac.sh` to syntax-check.)

- [ ] **Step 4: Smoke-test the node script**

Run: `bash -n scripts/podman-setup-mac.sh && node --check scripts/generate.env.mjs`
Expected: no syntax errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/podman-setup-mac.sh scripts/generate.env.mjs
git commit -m "feat(scripts): loop-prompt for multiple ECAs during setup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Update .env.example, README, and LOCAL_SETUP_GUIDE

**Files:**
- Modify: `.env.example:61-67`
- Modify: `README.md:122-138`
- Modify: `docs/LOCAL_SETUP_GUIDE.md`

- [ ] **Step 1: Replace the SFDC block in .env.example**

In `.env.example`, replace lines 61-67 (the `# SALESFORCE CONFIGURATION` block) with:

```bash
# SALESFORCE CONNECTED APPS (ECAs)
# Configure one entry per External Client App. IDs must be unique kebab-case slugs.
# DEFAULT_FOR is optional — comma-separated list of org-type tokens (prod, sandbox, pre-release)
# or full https://*.my.salesforce.com URLs. The first ECA whose DEFAULT_FOR includes a login URL
# is the auto-selected default in the AddOrg dropdown for that login URL.

SFDC_ECA_1_ID=''
SFDC_ECA_1_LABEL=''
SFDC_ECA_1_KEY=''
SFDC_ECA_1_SECRET=''
SFDC_ECA_1_DEFAULT_FOR=''

# SFDC_ECA_2_ID=''
# SFDC_ECA_2_LABEL=''
# SFDC_ECA_2_KEY=''
# SFDC_ECA_2_SECRET=''
# SFDC_ECA_2_DEFAULT_FOR=''

# Optional: legacy consumer secret used to decrypt v1-encrypted access tokens.
# If you have org tokens that were written with the old single-ECA setup, set this to the
# value of the original SFDC_CONSUMER_SECRET. Tokens written under the new setup ignore this.
SFDC_LEGACY_CONSUMER_SECRET=''

SFDC_CALLBACK_URL='http://localhost:3333/oauth/sfdc/callback'

# Generate using `openssl rand -base64 32`
SFDC_ENCRYPTION_KEY=''
```

- [ ] **Step 2: Update README.md**

In `README.md`, replace lines 122-138 (the Connected App section) with documentation that explains the multi-ECA model. Provide a 2-ECA example like:

```markdown
### Salesforce Connected Apps (ECAs)

Each Salesforce org that hosts a Connected App requires its own ECA entry in `.env`.
Configure them as numbered env vars:

\`\`\`
SFDC_ECA_1_ID='prod'
SFDC_ECA_1_LABEL='Production'
SFDC_ECA_1_KEY='3MVG9...'
SFDC_ECA_1_SECRET='...'
SFDC_ECA_1_DEFAULT_FOR='prod'

SFDC_ECA_2_ID='ncinodev'
SFDC_ECA_2_LABEL='nCino Dev Sandbox'
SFDC_ECA_2_KEY='3MVG9...'
SFDC_ECA_2_SECRET='...'
SFDC_ECA_2_DEFAULT_FOR='sandbox'
\`\`\`

`DEFAULT_FOR` accepts the tokens `prod`, `sandbox`, `pre-release`, or full
`https://*.my.salesforce.com` URLs (comma-separated). The AddOrg form auto-selects the first
ECA whose `DEFAULT_FOR` includes the chosen login URL; users can override via the
**Connected App** dropdown.

Single-ECA back-compat: if only `SFDC_CONSUMER_KEY` and `SFDC_CONSUMER_SECRET` are set,
they are auto-registered as a synthetic `default` ECA. Mixing legacy and numbered vars
is rejected at server startup.
```

(Use the actual heading style — likely H3 or H4 — that the surrounding README uses.)

- [ ] **Step 3: Update LOCAL_SETUP_GUIDE.md**

In `docs/LOCAL_SETUP_GUIDE.md`, locate the credentials section (around line 110-130) and update the prose to mention that the setup script now loops to collect multiple ECAs, and that 1Password should have one entry per ECA.

- [ ] **Step 4: Run prettier on the markdown**

Run: `npx prettier --write README.md docs/LOCAL_SETUP_GUIDE.md .env.example`

- [ ] **Step 5: Commit**

```bash
git add README.md docs/LOCAL_SETUP_GUIDE.md .env.example
git commit -m "docs: document multi-ECA Salesforce credentials configuration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Remove the deprecated env vars from env-config (optional, follow-up release)

**Files:**
- Modify: `libs/api-config/src/lib/env-config.ts`

> Skip this task in the same PR as Tasks 1-13. It is a follow-up that removes the back-compat shim. Leave checkboxes unchecked unless instructed otherwise.

- [ ] **Step 1: Remove SFDC_CONSUMER_KEY/SECRET fields from the Zod schema**
- [ ] **Step 2: Add a startup error in eca-registry.ts when those vars are still set, pointing to migration docs**
- [ ] **Step 3: Update README to remove the back-compat section**
- [ ] **Step 4: Bump major version**

---

## Self-Review

**Spec coverage:**
- Env var schema → Task 1 ✓
- Back-compat shim + mixed-config error → Task 1 ✓
- DEFAULT_FOR token expansion → Task 1 ✓
- `SFDC_LEGACY_CONSUMER_SECRET` → Tasks 1, 2, 7 ✓
- ECA registry public API → Task 1 ✓
- OAuth init resolves ECA → Task 4 ✓
- OAuth callback persists ecaId → Task 5 ✓
- Token refresh uses persisted ecaId with fallback → Task 6 ✓
- Encryption service decoupled → Task 7 ✓
- Schema migration → Task 3 ✓
- `GET /api/salesforce/ecas` endpoint → Task 8 ✓
- AddOrg dropdown with default snapping + override → Tasks 9, 10 ✓
- Org list ECA label subtitle → Task 11 ✓
- Setup scripts loop → Task 12 ✓
- Docs → Task 13 ✓

**Placeholder scan:** No "TBD"/"TODO"/"add error handling" strings. All code blocks contain runnable code. Step 1 of Task 11 directs the implementer to grep for the exact org list rendering file — that's a known-unknown, not a missing requirement.

**Type consistency:** `EcaConfig` shape is consistent across Tasks 1, 4, 5, 6. `EcaPublic` is consistent across Tasks 1, 8, 10, 11. `ecaId` field is `string | null` on the SalesforceOrg row (matches Prisma `String?`), `string | undefined` in TypeScript options types, and `string` in session storage (always written when init succeeds).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-multi-eca-credentials.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
