# Jetstream Podman Build — Engineering Log

## Context

**Date:** 2026-04-09
**Goal:** Get Jetstream v9.9.1 building and running locally using Podman Desktop instead of Docker Desktop (licensing restriction) on macOS (Apple Silicon) behind nCino's Zscaler SSL inspection proxy.
**Target audience for final guide:** Non-technical Salesforce administrators at nCino.
**Tools used:** Claude Desktop (initial troubleshooting) + Claude Code (continued troubleshooting, Dockerfile fixes, guide authoring).

---

## Starting State

The upstream Dockerfile had several issues when used with Podman on a corporate network:

1. Prisma's `postinstall` hook fails at build time due to missing environment variables
2. `.dockerignore` excludes files needed for TypeScript compilation
3. Podman VM has insufficient default memory for the Vite build
4. Corporate Zscaler proxy breaks DNS and TLS inside the Podman VM
5. Production dependency pruning removes Prisma CLI but postinstall still tries to run it

Prior work in Claude Desktop had already identified and documented fixes #1-#5 from the Zscaler/Podman perspective (captured in `JETSTREAM-PODMAN-SETUP.md`). This session focused on implementing those fixes in the actual codebase, discovering additional issues, and building successfully.

---

## Issues Encountered and Resolved (in build order)

### Issue 1: `Cannot resolve environment variable: JETSTREAM_POSTGRES_DBURI`

**Stage:** `yarn install` (postinstall hook runs `prisma generate`)
**Root cause:** `package.json` has `"postinstall": "prisma generate"`. When `yarn install` runs during the Docker build, it triggers `prisma generate`, which loads `prisma.config.ts`. That file calls `env('JETSTREAM_POSTGRES_DBURI')`, requiring the env var to exist. But no database URL is needed at build time — `prisma generate` only creates TypeScript client types from the schema; it does not connect to a database.

**Fix (Dockerfile):** Added a dummy env var before `yarn install`:
```dockerfile
ENV JETSTREAM_POSTGRES_DBURI=postgres://build:build@localhost:5432/postgres
RUN yarn install --frozen-lockfile --production=false
```

**Files changed:** `Dockerfile` (line 31)

---

### Issue 2: TypeScript errors — `pendingMfaEnrollment`, `user`, `pendingVerification` not found on `SessionData`

**Stage:** `yarn build:core` (TypeScript compilation of `apps/api`)
**Root cause:** The API's `tsconfig.app.json` includes `../../custom-express-typings` which contains Express session type augmentations (`SessionData` with `pendingMfaEnrollment`, `user`, `pendingVerification`). The `.dockerignore` uses a deny-all pattern (`*` on line 1) with explicit whitelisting. It whitelisted `!/custom-typings` but **not** `!/custom-express-typings` — these are two separate directories. The type augmentation directory was silently excluded from the build context.

**Diagnosis path:**
1. Build failed with ~10 TS2339 errors in `apps/api/src/app/controllers/auth.controller.ts`
2. Found `custom-express-typings/index.d.ts` contains `declare module 'express-session' { interface SessionData extends JetstreamSessionData {} }`
3. Confirmed `apps/api/tsconfig.app.json` includes `../../custom-express-typings`
4. Checked `.dockerignore` — only `!/custom-typings` was whitelisted, not `!/custom-express-typings`

**Fix (.dockerignore):** Added `!/custom-express-typings` to the include list.

**Files changed:** `.dockerignore` (line 9)

---

### Issue 3: Build silently killed at "rendering chunks..." (OOM)

**Stage:** `yarn build:core` → `jetstream:build:production` (Vite frontend build)
**Root cause:** Vite's "rendering chunks" phase is memory-intensive. The build script uses `NODE_OPTIONS=--max_old_space_size=8192` (8 GB max heap), but the Podman VM defaulted to ~3.8 GB total memory. The process was OOM-killed by the kernel with no error message.

**Diagnosis path:**
1. Build output showed `rendering chunks...` then jumped to `Failed tasks` with no error
2. Checked Podman machine memory: `podman machine inspect` showed `"Memory": 3814`
3. Confirmed the 8192 MB heap ceiling exceeded the VM's total memory

**Fix (Podman machine config):**
```bash
podman machine stop
podman machine set --memory 6144
podman machine start
```

6 GB is sufficient — the 8 GB is a ceiling, not a reservation; actual peak usage is 2-4 GB. This leaves 10 GB for macOS on a 16 GB laptop.

**Files changed:** None (runtime config)

---

### Issue 4: `getaddrinfo ENOTFOUND github.com`

**Stage:** `yarn install` (Electron package tries to download binaries from GitHub)
**Root cause:** After stopping and restarting the Podman machine for the memory change, the VM's internal DNS resolver (`192.168.127.1`) started returning `NXDOMAIN` for all queries. This appears to be a known issue with Podman's internal DNS gateway on corporate networks with Zscaler.

**Diagnosis path:**
1. `yarn install` failed with `RequestError: getaddrinfo ENOTFOUND github.com` from the Electron install script
2. `podman machine ssh "nslookup github.com"` → `NXDOMAIN`
3. `podman machine ssh "nslookup github.com 8.8.8.8"` → resolved successfully
4. Added `8.8.8.8` as fallback → primary resolver also started working

**Fix (Podman VM):**
```bash
podman machine ssh "echo 'nameserver 8.8.8.8' | sudo tee -a /etc/resolv.conf"
```

**Important:** This does NOT persist across `podman machine stop/start`. Must be re-applied after restarts.

**Files changed:** None (runtime config)

---

### Issue 5: `prisma: not found` (exit code 127)

**Stage:** `yarn install --production=true` and `yarn add` (post-build dependency pruning)
**Root cause:** The Dockerfile's production pruning step runs `yarn install --production=true`, which removes dev dependencies including `prisma`. But `package.json`'s `postinstall` hook (`prisma generate`) still fires, and `prisma` is no longer in `node_modules/.bin/`. The same issue occurs on the subsequent `yarn add cross-env ...` and `yarn add @react-email/components` commands — each triggers the postinstall hook.

**Fix (Dockerfile):** Added `--ignore-scripts` to all post-build install/add commands:
```dockerfile
RUN yarn install --production=true --ignore-scripts && \
    yarn add --ignore-scripts cross-env npm-run-all --save-dev

RUN yarn add --ignore-scripts @react-email/components
```

This is safe because the Prisma client was already generated in an earlier build step.

**Files changed:** `Dockerfile` (lines 51-56)

---

## Additional Issue: Disk space exhaustion

**Observation:** After several failed build attempts, `podman system df` showed 45 GB of dangling images (109 images, all reclaimable). Podman Desktop was reporting 50-60% usage of its 100 GB disk allocation.

**Fix:**
```bash
podman system prune -a -f
```
Reclaimed ~220 GB. Should be run periodically or after multiple failed builds.

---

## Complete List of File Changes

### `Dockerfile` (modified)
- Line 31: Added `ENV JETSTREAM_POSTGRES_DBURI=postgres://build:build@localhost:5432/postgres`
- Line 51: Changed `yarn install --production=true` → `yarn install --production=true --ignore-scripts`
- Line 52: Changed `yarn add cross-env npm-run-all --save-dev` → `yarn add --ignore-scripts cross-env npm-run-all --save-dev`
- Line 56: Changed `yarn add @react-email/components` → `yarn add --ignore-scripts @react-email/components`

### `.dockerignore` (modified)
- Line 9: Added `!/custom-express-typings`

### `docker-compose.yml` (modified)
- Removed `links: - db` from `jetstream` service
- Removed `links: - db` from `db_seed` service

### `apps/api/project.json` (modified)
- Line 17: Added `"external": ["@prisma/client", "@prisma/adapter-pg", ".prisma"]` to prevent Prisma from being bundled into CJS output

### `docs/LOCAL_SETUP_GUIDE.md` (new)
- Comprehensive step-by-step guide for non-technical Salesforce admins
- Covers Podman installation, Zscaler cert setup, memory config, DNS fix, env file creation, build, and run

### `docs/PODMAN-BUILD-ENGINEERING-LOG.md` (new)
- This file

---

## Final Build Command and Result

```bash
# One-time Podman machine setup
podman machine stop
podman machine set --memory 6144
podman machine start
podman machine ssh sudo tee /etc/pki/ca-trust/source/anchors/ZscalerRoot-FullBundle.pem < ~/Downloads/ZscalerRoot-FullBundle.pem
podman machine ssh "sudo update-ca-trust"
podman machine ssh "echo 'nameserver 8.8.8.8' | sudo tee -a /etc/resolv.conf"

# Build
podman build --no-cache -t jetstream-app .
# Successfully tagged localhost/jetstream-app:latest

# Run
podman compose up
```

**Build time:** ~15-20 minutes (no cache), faster with cached layers
**Image size:** TBD (verify with `podman images`)

---

## Issues Encountered During `podman compose up`

### Issue 6: `link is not supported`

**Stage:** `podman compose up` (container creation)
**Root cause:** `docker-compose.yml` uses `links:` directive, which Podman's compose provider does not support. The `links` feature is a legacy Docker concept — containers on the same compose network can already reach each other by service name or hostname.

**Fix (docker-compose.yml):** Removed both `links:` blocks (from `jetstream` and `db_seed` services). Services communicate via the shared `jetstream_default` network and the `hostname: postgres` setting on the db service.

**Files changed:** `docker-compose.yml`

### Issue 7: `ERR_INVALID_ARG_TYPE` — `import.meta.url` undefined at runtime

**Stage:** Application startup (`node dist/apps/api/main.js`)
**Root cause:** The API is bundled by esbuild with `"format": ["cjs"]` and `"bundle": true`. Prisma's generated client (`libs/prisma/src/lib/generated/prisma/client.ts`) uses `import.meta.url` to locate its engine binaries. In CJS output, `import.meta` is empty/undefined, so `fileURLToPath(import.meta.url)` throws.

The build had already warned about this:
```
▲ [WARNING] "import.meta" is not available with the "cjs" output format and will be empty
    libs/prisma/src/lib/generated/prisma/client.ts:16:53
```

**Fix (apps/api/project.json):** Added Prisma packages as external dependencies so they are NOT bundled into the CJS output and instead loaded from `node_modules` at runtime:
```json
"external": ["@prisma/client", "@prisma/adapter-pg", ".prisma"]
```

This matches the pattern used by the desktop app (`apps/jetstream-desktop/project.json`).

**Files changed:** `apps/api/project.json` (line 17)
**Status:** Fix applied but **image not yet rebuilt**. This is the next step.

---

## Current State and Next Steps

**Completed:**
- Image builds successfully with Podman
- `podman compose up` starts PostgreSQL, runs migrations/seed, and starts the app container
- All Dockerfile, .dockerignore, docker-compose.yml, and project.json fixes are in the working tree (not yet committed)
- Setup guide written at `docs/LOCAL_SETUP_GUIDE.md`
- Engineering log written at `docs/PODMAN-BUILD-ENGINEERING-LOG.md`

**Next steps (resume here):**
1. Rebuild the image: `podman build --no-cache -t jetstream-app .` (needed because `apps/api/project.json` changed — the Prisma externalization fix)
2. Run `podman compose up` and verify the app starts without the `import.meta.url` crash
3. Test the app at `http://localhost:3333/app` with example user login
4. If working, commit all changes
5. Update the setup guide with any final corrections

**Not yet done:**
- Changes not committed to git
- Guide not reviewed by target audience (non-technical Salesforce admins)
- `podman compose` vs `podman-compose` — on this system, `podman-compose` is not installed; `podman compose` works (delegates to `/usr/local/bin/docker-compose`). Guide references both but should be updated once a standard is chosen.

---

## Podman Machine Config Summary

| Setting | Default | Required |
|---|---|---|
| Memory | ~3.8 GB | 6 GB (`--memory 6144`) |
| Zscaler cert | Not installed | Must install into `/etc/pki/ca-trust/source/anchors/` |
| DNS fallback | None | `8.8.8.8` appended to `/etc/resolv.conf` (non-persistent) |

---

## Docker vs Podman Differences Encountered

| Behavior | Docker | Podman |
|---|---|---|
| `COPY --link` | Supported (BuildKit) | Not supported — remove `--link` flag |
| DNS in build VM | Usually works | May need manual DNS fallback on corporate networks |
| CA trust | Host certs often inherited | Must manually install into Podman machine VM |
| `docker compose` | Built-in subcommand | `podman compose` delegates to external `docker-compose` binary |
| Default VM memory | N/A (uses host) | ~4 GB — insufficient for large JS builds |
