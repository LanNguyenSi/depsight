# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **The production database is no longer reachable from the edge network or from every interface, and its password is no longer fixed in the shipped files:** `docker-compose.traefik.yml` put `db` on the public `traefik-public` network next to every routed service, and `docker-compose.yml` published 5432 on all interfaces, both with the password `depsight` written into the file (so `.env` could not override it). Now the `db` service of the traefik file sits only on the private `db-internal` network (`internal: true`, scoped by compose to the project as `depsight_db-internal`, no published port; `app` carries `traefik.docker.network=traefik-public` so Traefik never routes to it), `docker-compose.yml` publishes Postgres on `127.0.0.1:5432` only, and both files take the password from `${POSTGRES_PASSWORD}` for the database and the app's `DATABASE_URL` alike. `docker-compose.yml` refuses to start while `POSTGRES_PASSWORD` is unset or empty; the traefik file falls back to `depsight` (the live database's password) so the hosted deploy needs no change. The `.relay.yml` `post_update` hook no longer holds a copy of the credentials, the network or the host path of the checkout: it runs the new one-shot `migrate` service (today `docker compose -f docker-compose.traefik.yml run --rm -T --build migrate`, see the migrate entry below). The next hosted deploy recreates the `db` container once on the same volume. Upgrade for existing self-hosted installs: set `POSTGRES_PASSWORD=<your current database password>` (`depsight` unless you changed it) in `.env` before the next `make prod` (the file now refuses to start without it), then rotate. Upgrade notes for self-hosters, and the rotation of a live password (`ALTER USER`, then `.env`), are in [Self-hosting](docs/configuration.md#self-hosting); `scripts/check-compose-isolation.mjs` (CI) fails if a production file reopens either exposure.
- **Dev and production compose stacks can no longer share a project or a database volume:** no compose file set a project name, and all three declared the volume `postgres_data`, so in a production checkout `make test`, `make dev` or `make dev-clean` (`down -v`) acted on the production database. Each file now sets `name:` (`depsight` for both production files, which keeps the existing volume `depsight_postgres_data`; `depsight-dev` for the dev file), and the dev Makefile targets pass `-p depsight-dev`. Changed behaviour: the dev database now lives in `depsight-dev_postgres_data` and starts empty once; an old dev volume `depsight_postgres_data` is left untouched. A self-hosted checkout whose directory is not named `depsight` sets `COMPOSE_PROJECT_NAME=<directory>` in `.env` to keep its volume.

### Changed

- **Every production service has a memory limit and a rotated log, and the app has a healthcheck and an explicit heap limit:** `docker-compose.yml` and `docker-compose.traefik.yml` gave no service a memory limit or a `logging` block, so the json-file driver kept one unbounded log per container and one runaway service could take the memory the database needs. `app` now has `mem_limit: 1536m` with `NODE_OPTIONS=--max-old-space-size=1024` (the V8 heap is the binding limit, set explicitly instead of derived from the cap), `db` and `migrate` `512m`, and all three log through `json-file` with `max-size: 10m` and `max-file: 3`. The `app` service also has a healthcheck (an inline `node -e` request to `/api/health` with a 9 second fetch timeout, a 10 second probe timeout, every 30 seconds, five retries, a 40 second `start_period` probed every 2 seconds) that fails on the 503 the endpoint returns when the database is unreachable. Plain compose does not restart an unhealthy container, but the hosted file's Traefik does not route to a container that is `starting` or `unhealthy` (default settings): after every recreate the public routes answer 404 until the first passing probe (about 2 seconds after the server is up), and after five failed probes in a row (database down, or an event loop blocked past the probe timeout) they answer 404 until a probe passes. `scripts/check-compose-isolation.mjs` (run by CI, with a test that runs it against mutated copies of the compose files) now fails when a service loses its log rotation or memory limit, or the app its healthcheck, a check of the answer status, its `start_period` or its wait for a healthy `db`. One-time effect: the first deploy recreates the `db` and `app` containers (a short Postgres restart; the data volume is untouched), and the limits are sized from a dummy environment and an idle production instance, so sample `docker stats` across a full auto-scan cycle before the deploy. See `docs/configuration.md`, Health check, resource limits and log rotation.
- **One documented production compose path:** the Self-hosting chapter sent operators to `docker-compose.yml` while `docs/ways-of-working.md` and `.relay.yml` deploy `docker-compose.traefik.yml`, two files that differ in published ports, networks, labels and schema step. `docs/configuration.md` now starts with "Which compose file": `docker-compose.yml` is the self-hosting path, `docker-compose.traefik.yml` the hosted instance's file (its hostnames, not a second recommendation), with a table of the differences; `docs/ways-of-working.md`, the README and a header comment in `docker-compose.yml` say the same. No file is renamed.

### Fixed

- **The production schema step runs the Prisma CLI the lockfile pins, built into an image, and fetches nothing at deploy time:** the `migrate` service ran a stock `node:20-slim` and downloaded `prisma@5.22.0` with `npx` (plus `apt-get install openssl`) on every deploy, a fixed CLI one major behind the app's `@prisma/client` 6 and a network fetch on the deploy path, which also forced the service onto the default network next to `db-internal`. It is now the `migrate` stage of the `Dockerfile` (the CLI from `package-lock.json`, openssl and the schema baked in) and sits only on `db-internal`, which has no route out. The command keeps its two steps in order, the pre-push Advisory SQL and then `db push --skip-generate`, with the same `DATABASE_URL`. Checked on a throwaway Postgres: a schema created by the old `prisma@5.22.0` path is reported "already in sync" by the new image with an identical schema dump and its rows untouched, and a fresh database gets the same schema as the old path. Deploy note: the relay runs `pre_update` on the tree from before the pull, a plain `docker compose build` skips a profile-scoped service, and `docker compose run` reuses an existing image, so the image is built by the `post_update` step itself, `docker compose -f docker-compose.traefik.yml run --rm -T --build migrate` (from the post-pull tree, with the layer cache: the dependency layers are shared with the app build of the same commit, which the relay's plain build has just made; a schema change rebuilds the dependency stage and the migrate layers); `pre_update` is unchanged. The first deploy builds the migrate image in `post_update` (one more image build, no manual step). `tests/unit/migrate-image.test.ts` pins the build target, the absence of any `prisma@<version>`, `npx` or package fetch in the step, that `post_update` builds migrate before running it and `pre_update` does not, the non-root user, and that the lockfile's CLI version equals `@prisma/client`'s.
- **A production instance without a session secret or a usable public URL no longer starts:** `NEXTAUTH_SECRET` and `NEXTAUTH_URL` were first read at the first sign-in, so a host move that lost the `.env`, or a `.env` copied from `.env.example` with a relative or missing URL, passed the database-only deploy check and failed every login. With `NODE_ENV=production`, `instrumentation.ts` now checks both at server start: a missing, empty or blank `NEXTAUTH_SECRET`, and a missing, empty or not absolute `http(s)` `NEXTAUTH_URL`, log the variable names (never the values) and exit with status 1, the path an invalid `SCAN_INTERVAL_MINUTES` already takes, so the restart loop keeps the new version from answering the deploy check. A loopback `NEXTAUTH_URL` (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, `*.localhost`) only logs a warning, because the self-hosting compose file legitimately serves a local instance. Development and test runs and the image build are not checked. `/api/health` stays a database check. Before deploying, make sure the production `.env` holds both variables; without them the relay rolls the deploy back.
- **npm CVE queries also cover a project whose declared range the repository-wide lockfile version does not satisfy, and a `latest`, tag or `*` declarer:** the OSV channel asks for one version per package name for the repository as a whole (the merged lockfile version, else the lowest manifest floor), so a project that declares a package but installs another version of it was never queried at that version. Two shapes were found by review. A root `vite ^8.3.0` locked at 8.3.5 beside a `docs/` project with `vite ^6.0.0` and no lockfile queried only 8.3.5, although `docs/` installs a 6.x. And an `a/` project declaring `vite: latest` locked at 7.3.7 beside a `b/` project with `^8.3.0` locked at 8.3.5 queried 8.3.0 and 8.3.5, never 7.3.7. Now, additionally and with nothing the scan queried before removed: for every declaration in `dependencies` or `devDependencies` (an `npm:` alias counts as a declaration of its real name) that is a plain semver range which the one merged lockfile `resolved` version does not satisfy (a prerelease only satisfies a range that names a prerelease of the same release), the range's lowest version is queried as well; and for every such declaration that has no range to compare (`latest` or another tag, a git or `file:` spec, `*`), every version any lockfile records for the package, nested copies included (lockfileVersion 2 or 3 and `yarn.lock`; a lockfileVersion 1 lockfile is read top-level only), is queried, not only the lowest one the ambiguous fallback kept. The narrow per-lockfile override and its drop proof are unchanged and still apply to these entries. A package name with no single resolution is covered by the entry below. Not covered: declarations only in `optionalDependencies`, `peerDependencies` or `bundleDependencies` of a project without a lockfile of its own, a project that declares a range the resolved version satisfies but installs a different version (no per-project provenance in the repository-wide map), and npm workspace monorepos (separate task). Tests: `tests/unit/osv-declarer-floor.test.ts` (each branch and input combination on its own, plus a seeded property test that the result is the previous result plus exactly these additions), `tests/unit/osv-narrow-scenarios.test.ts` (exact query sets of both shapes, `declarerRangeBelowRootLock` and `latestDeclarerBesideLockedRange`). Tracker task b08df28b.
- **npm CVE queries also cover every plain-range declarer and every lockfile copy of a package name with no single resolution:** the entry above widened the query only for a name with one merged lockfile version. For a name the lockfiles resolve ambiguously (several versions, for example in a `yarn.lock`, or two lockfile formats that disagree) or that no lockfile records, only the floor of the lowest declared range was queried, so a declarer of a higher range and the lockfile copies of the name were not: a `yarn.lock` with vite 8.3.5 and 7.3.7, root `^8.3.0` and `docs/` `^6.0.0` queried only vite@6.0.0, and without any lockfile `^8.3.0` beside `^6.0.0` queried only vite@6.0.0. Now, additionally and with nothing the scan queried before removed: for such a name, the floor of every `dependencies` or `devDependencies` declaration with a plain range (an `npm:` alias counts under its real name) is queried, and so is every version any lockfile records for the name (nested copies included for lockfileVersion 2 or 3 and `yarn.lock`), even one outside every declared range, since a stale lockfile can still install it. Plain range means a spec `semver.validRange` accepts that is not a wildcard (`*`, `x`, empty): `^`, `~`, comparator sets, x-ranges, hyphen ranges, `||` unions and exact pins. Its floor is the exact version after the operator, else the lowest version the range admits; a `||` union has the floor of its lowest alternative only, and a range that admits no version has none. A wildcard, tag, git or `file:` spec is not a plain range and keeps adding every lockfile version, as before. A name with a single merged resolution behaves as before. This can report more advisories (a floor or a lockfile copy nobody installs), never fewer; the narrow per-lockfile override and its per-pair drop proof are unchanged and apply to the new entries too. Tests: `tests/unit/osv-declarer-floor.test.ts` (single, ambiguous and unresolved name against plain-range, non-range and wildcard declarers, the range forms, and a seeded property test that the result is the previous result plus exactly these additions), `tests/unit/osv-narrow-scenarios.test.ts` (`WIDENED` lists the added pairs per scenario; `declarerRangesBesideAmbiguousYarnLock` and `declarerRangesWithoutAnyLock` are the two former residuals). Tracker task 91db5e84.
- **Review-round labels removed from code comments:** the comments in `lib/cve/osv.ts` and `lib/manifest-discovery.ts` no longer cite run-local review rounds (`R1`, `R2`); the rationale stays. Tracker task 84a1b54b.
- **npm CVE queries for repositories of separate projects use the versions their own lockfiles install, not a floor installed nowhere:** the OSV channel merges every `package-lock.json` of a repository into one `name -> version` map, so a package that resolves to different versions in different subprojects (for example vite 7.3.7 in `frontend/package-lock.json` and 8.3.5 in `backend/package-lock.json`) was ambiguous and queried at the floor of the manifest spec (`^7.3.5` -> 7.3.5), a version no lockfile installs, which raised advisories (for example `>=7.0.0 <7.3.7`) that `npm audit` does not report. On top of the unchanged repository-wide result, each dependency is now also looked up in the `package-lock.json` in its own manifest's directory (lockfileVersion 2 or 3, the top-level `node_modules/<name>` entry), so a package installed at several versions is queried once per installed version. The repository-wide entry for a name is removed only when everything the scan reads is positively accounted for and no `package-lock.json` the scan reads installs it (vendored, build and fixture directories are not read); anything that cannot be read or checked keeps the entry. All of these must hold: the git tree and manifest list were read completely; the repository has none of the files `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `npm-shrinkwrap.json`, `deno.lock`, `.npmrc` (which can switch the lockfile off), `pnpm-workspace.yaml`, `.yarnrc.yml` and `.pnpmfile.cjs`, and no `package.json` the scan reads has a `packageManager` or `devEngines.packageManager` field; every `package.json` the scan reads is locked, that is, it has a `package-lock.json` of its own with a known shape (lockfileVersion 2 or 3 with a `packages` map) that lists every key of its `dependencies`, `devDependencies`, `optionalDependencies` and `peerDependencies` (a peer that `peerDependenciesMeta` marks `optional: true` excepted) as a top-level entry whose version satisfies the declared range, and in which every entry of a name the manifest overrides satisfies that override (an `overrides` entry that is not a plain string, such as a nested object or a `$` reference, counts as not locked); a version satisfies a range as npm judges a lockfile (loose parsing, prereleases only for a range that names a prerelease of the same release), and for a spec that is not a plain semver range the entry only has to exist; a project without such a lockfile installs fresh, through a transitive dependency, a peer dependency or `overrides`, and nothing here can see what; every manifest that declares the name (in `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` or `bundleDependencies`) has no `workspaces` key (neither itself nor in any parent `package.json`), declares it as a plain semver range (no `npm:` alias), and has a lockfile whose installed version satisfies that range; and no fetched lockfile installs the repository-wide version at any path (nested copies included). The lockfiles are indexed once under a total size bound, and a repository beyond it keeps every entry. Every lockfile entry that names a package must carry a semver version (an `npm:` alias is resolved first); an entry that does not (a git, tarball or `file:` version, no version, not an object) makes that package name unknown, an unknown name is never removed, and a lockfile of an unknown shape keeps every entry. A lockfileVersion 1 lockfile anywhere in the repository keeps every entry: npm takes each package's dependency edges from the registry, not from a v1 lockfile, so such a lockfile does not show everything that is installed. The `dependencies`, `optionalDependencies` and `peerDependencies` edges of every `packages` entry (the root entry and workspace folders included; a peer that the entry itself marks optional in `peerDependenciesMeta` excepted) are read too: an edge to a name the same lockfile has no entry for (a lockfile written with `--legacy-peer-deps`, a damaged or hand-edited one) makes the lockfile unusable and keeps every entry, because `npm install` resolves such an edge from the registry. Two exemptions: an entry the lockfile marks `inBundle`, and a name the entry itself lists in `bundleDependencies` or `bundledDependencies` (npm takes it from the package tarball), which only makes that name unknown. The range of an edge is not compared with the version the lockfile holds. Optional, peer and bundled declarations can keep an entry; an optional or peer declaration also adds the version its own lockfile installs (next entry), a bundled name never adds a query. What the removal guarantees: no under-reporting for an install that honours the lockfiles, that is `npm ci`, or `npm install` on a lockfile with no missing or invalid edge (under `npm ci` npm refuses a lockfile that differs from the ideal tree, so the lockfile is the install). Not covered by that guarantee: `npm install` on a lockfile whose transitive edges are inconsistent (npm re-resolves them from the registry; only an edge to a name with no entry at all is noticed, not an edge the lockfile does not satisfy at the location npm resolves it from, out of range or present only on another branch), a git or `file:` dependency changed without updating the lockfile, the contents of a bundling optional package that the lockfile was written without unpacking (on another platform), command line flags, a user or global npmrc, the environment and the state of the registry. Not covered, and unchanged: npm workspace monorepos (any `workspaces` key), repositories with another package manager's lockfile, and repositories whose tree or manifest list was truncated; there the scan behaves as before. Transitive-only copies are still not queried. Tests: `tests/unit/osv-narrow-scenarios.test.ts` (each repository with the query set of the previous code), `tests/unit/osv-narrow-conditions.test.ts`, `tests/unit/narrow-npm-resolution.test.ts`, `tests/unit/osv-narrow-property.test.ts`, `tests/unit/osv-multi-version-advisories.test.ts`. Tracker task e82ab6ab.
- **npm CVE queries also use the versions that peer and optional declarations install:** in a repository of separate projects, the lockfile-backed versions the scan queries for a package came only from `dependencies` and `devDependencies`. A project that declares a package only in `peerDependencies` (a plugin on its host) or `optionalDependencies` installs it under `npm ci` (a non-optional peer and every optional dependency of a root project; an optional peer only when something requires it, in which case its lockfile has the entry), but that version was never queried, while the repository-wide floor entry could be removed because another project installs a higher version. Example: `a/` has `vite ^7.3.5` locked at 7.3.7, `b/` has `peerDependencies: { vite: ^7.3.6 }` locked at 7.3.6; the scan queried only vite 7.3.7, so an advisory affecting `<7.3.7` that hits `b/`'s installed 7.3.6 was missed. Now an `optionalDependencies` or `peerDependencies` declaration is narrow, and adds the version, under the same conditions as a dependency: a complete tree, no other package manager's lockfile, a standalone project (no `workspaces` key in it or above it), a plain semver range (no `npm:` alias), and a top-level entry in the project's own lockfile (lockfileVersion 2 or 3) with a real semver version that satisfies the range. A peer that `peerDependenciesMeta` marks optional adds only when its lockfile lists it. A name that is another project of the repository is never queried. A bundled name carries no range and still never adds. This only adds queries: when a floor entry is removed is unchanged (the same conditions, the same answer for every repository), and an addition can only report more advisories, never fewer. Tests: new scenarios and unit tests in `tests/unit/osv-narrow-scenarios.test.ts` and `tests/unit/narrow-npm-resolution.test.ts`, and the property test `tests/unit/osv-narrow-property.test.ts` (an oracle for the additions, and the check that the result never lacks a query of the previous behaviour).
- **The npm dependency-age report shows the version a lockfile installs, not the manifest floor, where the CVE scan's proof holds:** the report took each package's installed version by stripping the range operator from the manifest spec (`^7.3.5` -> 7.3.5), so with lockfiles that install 7.3.7 it listed, aged and classified a version nobody installs. The row still starts from that manifest floor (one row per package name, the lowest declared spec). It rises above the floor only where every declaration of the package is in `dependencies` or `devDependencies`, every project that declares it has its own `package-lock.json` whose top-level entry proves the version it installs for that declaration, and no `package-lock.json` the scan reads installs the floor itself; this is the CVE scan's proof that the floor is installed nowhere. The row is then the lowest of those top-level versions, in semver order (9.1.5 is lower than 10.0.1; vite 7.3.7 in `frontend/package-lock.json` and 8.3.5 in `backend/package-lock.json` with spec `^7.3.5` shows 7.3.7). It is never lower than the floor: a lowest lockfile version below the floor keeps the floor. A declaration in `optionalDependencies`, `peerDependencies` (marked optional or not) or `bundleDependencies` keeps the floor: the report row is raised only from `dependencies` and `devDependencies` declarations, so a raised row could skip the version that project installs (a project with vite as a peer dependency locked at 7.3.6 beside one with it in `dependencies` locked at 7.3.7 shows the floor 7.3.5, not 7.3.7). A copy installed only as a dependency of another package (nested, or hoisted in a project that does not declare it) is not reflected in the row; a copy of the floor anywhere keeps the floor. In every other case the row is the floor strip, as before: a project without a `package-lock.json` of its own, an unreadable, malformed or lockfileVersion 1 lockfile, a lockfile that does not list a declared dependency in range, a `workspaces` key, an `npm:` alias, a `.npmrc`, another package manager's lockfile (a repository with a `yarn.lock` only keeps the floor), a truncated tree, or a spec with no usable floor (`latest`). A project that has no lockfile never gets the version of another project's lockfile. The publish date, age in days and status (up to date, outdated, major behind) are computed for the shown version; a version the registry has no publish time for gives age -1 (unknown), as before. A lockfile that cannot be read keeps the floor and marks the dependency-age scan as degraded, the same way as the CVE scan. The report reads the `package-lock.json` files of the manifests' directories in addition to the manifests (the manifests are not read twice). Not changed: the CVE scan and other ecosystems. Tests: `tests/unit/deps-age-lockfile.test.ts`, `tests/unit/osv-narrow-property.test.ts`. Tracker task e82ab6ab.

## [0.9.0] - 2026-10-25

**Headline: the PR scan webhook (per-repository secrets, fork-scan default, pre-verification limits), Cargo.lock and Gradle scans, and per-finding advisory triage.** Upgrade: the instance-wide `GITHUB_WEBHOOK_SECRET` is removed; each repository's webhook secret is generated on the settings page and sealed with `WEBHOOK_SECRET_KEY` (fallback `NEXTAUTH_SECRET`); `SCAN_INTERVAL_MINUTES` must be a whole number from 1 to 35791 or the process exits at startup; the deploy hook's `prisma db push` applies the schema changes. The published MCP package is released as `@opentriologue/depsight-mcp` 0.6.1 (tag `depsight-mcp-v0.6.1`): it moves its `zod` dependency to 4.6.7 (GHSA-mrhx-c7xc-m3w5) and reports version 0.6.1 in the MCP handshake. depsight is deployed from `master`; this tag is deploy provenance.

### Added

- **PR scan webhook: GitHub's hook addresses get their own pre-verification budget:** a request whose trusted client address (the hop chosen by `WEBHOOK_TRUSTED_PROXY_HOPS`, never an entry to its left) lies in the `hooks` ranges of `https://api.github.com/meta` (IPv4 and IPv6; an IPv4-mapped IPv6 address counts as its IPv4 address) is classified before the per-address check and counted against a per-address table of its own (60 a minute and 10 000 windows at most, so requests the trusted hop places outside the ranges cannot fill it) and a budget of 300 a minute that those requests cannot spend, instead of the general per-address table and the 600 endpoint-wide ceiling, which it no longer touches. So a caller reaching the app through the proxy with many source addresses that exhausts the ceiling, or fills the general per-address table, no longer makes GitHub's deliveries answer 429, and GitHub does not redeliver those by itself. Deliveries that any GitHub user points at the URL come from the same ranges and share the hook budget; the ranges separate GitHub's infrastructure from other sources, not this instance's deliveries from everyone else's. With `WEBHOOK_TRUSTED_PROXY_HOPS=0` no request is classified, nothing is fetched and every caller shares the `unknown` address and the ceiling. The ranges are fetched lazily (never at import, by one background fetch with a 5-second timeout and no waiting request), read with a 2 MiB cap before parsing, cached for an hour, retried no sooner than five minutes after a failure and dropped after 24 hours without a refresh; entries wider than an IPv4 /8 or an IPv6 /16 are dropped; before the first successful fetch, after a failure, or for an unusable response every request shares the single ceiling as before. The first refusal over the hook budget in a window logs one warning. CIDR matching is a small dependency-free matcher in `lib/ip-cidr.ts`. The budget rests on the trusted hop: where the app is reached without the proxy a caller can write that entry and claim a hook address, so the work an unauthenticated caller can cause is bounded by the two budgets together, 900 requests a minute (roughly 36 CPU-seconds at about 40 ms per crafted request, against roughly 25 for the ceiling alone). Documented in `docs/api.md`, `docs/configuration.md` and `.env.example`. Tests: `tests/unit/ip-cidr.test.ts`, `tests/unit/github-hook-ranges.test.ts`, `tests/unit/pr-webhook-preauth.test.ts`. Tracker task 7894b047.
- **PR scan webhook: pre-verification rate limit and an opt-out:** `POST /api/webhooks/github` now counts every request against a fixed one-minute window per client address (60) and one for the whole endpoint (600) before the body is read, parsed or hashed, and answers 429 with `Retry-After` over either, so unauthenticated traffic can no longer burn unbounded CPU on JSON parsing and HMACs. The client address is the hop a trusted proxy appended to `X-Forwarded-For`, counted from the right (`WEBHOOK_TRUSTED_PROXY_HOPS`, default 1 for traefik, 0 ignores the header); entries to its left never mint a bucket of their own, and neither does a non-address entry (an IPv6 zone id or anything over 45 characters counts as one); `unknown` is one shared bucket for requests whose trusted entry is missing (fewer entries than hops; Next.js fills an absent header with the socket peer) or not an address. The per-address table is capped at 10 000 windows. Where the header cannot be trusted (the app reached without the proxy) the endpoint-wide figure still bounds the work (together with the hook-address budget of task 7894b047, 900 a minute), at the cost that a spoofing caller can make deliveries answer 429 for the rest of the minute. Behind the proxy the endpoint-wide figure can be spent honestly too (60 a minute from each of ten source addresses), and GitHub does not redeliver by itself, so the first refusal of each window logs one warning and `docs/api.md` documents the residual; a hook-address allowlist at the proxy would remove it. `GITHUB_WEBHOOK_DISABLED=true` switches the endpoint off (404, body unread). Documented in `docs/api.md`, `docs/configuration.md` and `.env.example`. Tests: `tests/unit/pr-webhook-preauth.test.ts`, `tests/unit/client-ip.test.ts`, `tests/unit/rate-limit.test.ts`. Tracker task c160f639.
- **Fork scanning of the PR scan webhook can be enabled per tracked repository:** `Repo.webhookScanForks` (one nullable boolean column, applied by the unchanged `prisma db push`) overrides `GITHUB_WEBHOOK_SCAN_FORKS` for that row; `null` follows the env default, which is now documented as the instance default. The tracking user sets it in Settings or with `PATCH /api/webhook-secrets/[repoId]` (`{ "scanForks": true | false | null }`, session and owner only; `GET /api/webhook-secrets` reports `scanForks` per row and `scanForksDefault`). The webhook reads the setting of the one row whose secret verified the delivery, after the signature check and before the replay guard, so when several users track one repository each row decides for itself and no row's opt-in enables fork scans for another user's row. A replay of the deploy hook against a Postgres seeded at the previous schema, with existing rows, applied the push without a prompt and kept the rows. Tracker task b7e283de.
- **PR scan webhook skips fork pull requests by default:** a delivery whose `pull_request.head.repo.full_name` differs from `repository.full_name` (case-insensitive; a deleted fork with `head.repo` null counts as a fork, as does a payload without a head repository) is answered 200 `ignored` after the per-repository signature has been verified and before the replay guard and the rate limiters, so it costs no scan budget, and an unverifiable delivery still gets the uniform 401 (the fork answer never reaches a caller without a valid secret). On a public repository any outsider could otherwise trigger the scan and read alert data from the comment. Set `GITHUB_WEBHOOK_SCAN_FORKS=true` to scan forks again. Documented in `docs/configuration.md` and `docs/api.md`. Tracker task 5857ef12.
- **PR scan webhook:** `POST /api/webhooks/github` scans a pull request from a GitHub `pull_request` webhook (`opened` and `synchronize`) and posts or updates the CVE comment through the existing PR scan, without a session. Authentication is the HMAC-SHA256 `X-Hub-Signature-256` of the raw body under the webhook secret of the tracked repository the payload names (one secret per user and repository, see the Security entry below), compared with `timingSafeEqual`; without sealing key material the endpoint answers 503 and scans nothing. Unsigned, wrongly signed and wrong-length signatures, and deliveries for a repository that is not tracked or has no secret, all answer the same 401; a body over 1 MiB 413, and a replayed delivery (same `X-GitHub-Delivery` id or same body digest for the same tracking row, remembered 24 hours in process memory, sized for the full rate limit) is ignored with 200. A verified `ping`, other events and actions (`reopened` included) are answered 200 and ignored; only the PR number, action and head repository name of a verified payload are used (plus the owner and repository name for the lookup) and no payload URL is fetched. The scan runs in the background after a 202 and uses the GitHub token of the user whose secret verified the delivery. Rate limited to 60 verified deliveries per tracking row, 120 per user (all that user's rows together) and, as a server-protection ceiling rather than a scan budget, 3000 per hour overall. Setup is in `docs/configuration.md`. Tests: `tests/unit/pr-webhook-route.test.ts`, `tests/unit/pr-webhook-security.test.ts`, `tests/unit/pr-webhook-timing-safe.test.ts`. Tracker tasks 12dc3fed and 4f058131.
- Rust scans read `Cargo.lock` to report the exact locked version of each crate declared in `Cargo.toml` (as for npm and Python, only declared crates are reported; transitive-only crates in the lock are not added). Each `Cargo.toml` resolves against its nearest `Cargo.lock` (its own directory, then each ancestor up to the repo root), as Cargo does, so workspace members use the root lock and an unrelated nested lock (for example `fuzz/Cargo.lock`) never affects another manifest. When a crate is locked at several versions, the highest one satisfying the `Cargo.toml` requirement is reported; if none satisfies it, the requirement is kept. Workspace-local, `git+` and alternate-registry lock entries are ignored. Tracker task 7478e2c2.
- Java scans read Gradle build files (`build.gradle`, `build.gradle.kts`): dependencies declared in `implementation`, `api`, `compileOnly`, `runtimeOnly` and `testImplementation`, in call and map notation, are reported when their version is written literally. Interpolated coordinates, catalog, platform and dynamic versions, and declarations inside constraints blocks are skipped rather than guessed. Gradle and pom dependencies share the existing root-first dedupe, and a repo scanned without a manifest list also tries the root `build.gradle` and `build.gradle.kts`. Tracker task cbf3912e.
- **Per-finding triage:** a CVE finding can be acknowledged or ignored per repository (`AdvisoryState`: status, who, when, optional note). `PUT` and `DELETE /api/advisory-state` set and clear it (session or `WRITE` Bearer token, scoped to the caller's own tracked repositories; a foreign repository answers 404), the CVE list in the dashboard has Acknowledge / Ignore / Reopen buttons and a "Hide ignored" toggle, and `GET /api/scan` (so also the MCP `depsight_get_cves`) carries an additive `state` object per advisory. The state is keyed by advisory id plus package and survives rescans. Ignored findings are still counted: the severity counts, the risk score, policies and notifications are unchanged. Tests: `tests/unit/advisory-state-route.test.ts`, `tests/unit/advisory-state-client.test.ts`, `tests/unit/scan-route.test.ts`. Tracker task ec97f46f.

### Changed

- **A signed PR scan webhook delivery refreshes the stored repository visibility:** when the verified delivery clearly states a visibility (`repository.private` or `repository.visibility`) that differs from the row's stored `private` flag, that one row is updated, so the settings page (which reads the stored flag) converges on the first delivery after a visibility change instead of waiting for a sync. A missing, mistyped or contradictory field, an invalid signature or an unmatched repository never writes, and a failed write is logged without changing the delivery's answer. A later redelivery or replay of an older signed delivery can set the stored flag back until the next delivery or sync; the server's fork decision is unaffected because it reads each delivery. Documented in `docs/api.md`. Tracker task 60ae7012.
- **The per-repository fork opt-in of the PR scan webhook is ignored for public repositories:** the webhook now judges visibility from each delivery's `repository.private` and `repository.visibility` (a missing, mistyped or contradictory value counts as public; an `internal` repository counts as private), so a repository that turned public stops scanning outsiders' forks with its next delivery, without waiting for a sync. An explicit opt-out still holds and `GITHUB_WEBHOOK_SCAN_FORKS` keeps its meaning. `GET /api/webhook-secrets` reports the stored `private` flag; the settings page keeps Ignore selectable and disables Scan on a public row, says why, and disables the select for a row without a secret. Tracker task 9a2eadf8.
- **Fork-scan default read in one place:** the webhook route and `GET /api/webhook-secrets` read `GITHUB_WEBHOOK_SCAN_FORKS` through one helper (`lib/pr/scan-forks-default.ts`), so the default the settings page shows cannot drift from the one the webhook applies; the settings-route tests reset the variable after each test. Tracker task 7c744d19.
- **Fatal startup configuration errors exit the process.** An invalid `SCAN_INTERVAL_MINUTES` made the instrumentation hook throw, but the Next.js server stayed up and answered every request with 500, so a restart policy never fired. The hook now logs the error and exits with status 1 (verified with the standalone `node server.js` the image runs). Tracker task 894d4d5f.
- **Settings page disables Generate and Rotate when webhook secrets are unavailable.** With no key material (`WEBHOOK_SECRET_KEY` and `NEXTAUTH_SECRET` unset) both buttons answered 503; they are now disabled with the reason as their title, and Remove stays available. Tracker task 894d4d5f.
- **`SCAN_INTERVAL_MINUTES` is validated at startup.** Values above 35791 minutes overflowed the 32-bit timer delay, so the scan ran in a tight loop. The variable must now be a whole number from 1 to 35791 (unset or blank still means 60); anything else (0, negative, non-numeric, fractional, too large) fails startup with an error naming the maximum instead of being silently replaced by 60 or overflowing. Tracker task 0e581af9.
- `Repo` has a non-unique index on `(owner, name)`, so the PR scan webhook's tracked-repository lookup and other lookups by owner and name no longer scan the table. The deploy hook (`.relay.yml` `post_update`) applies it with its bare `prisma db push` and no `--accept-data-loss`; a replay of the hook commands (prisma 5.22.0) against a Postgres holding `Repo` rows with the same owner and name under two users applied it without a prompt and a second push found nothing to change. Tracker task d40188f4.
- **`Advisory` is unique per `(scanId, ghsaId, packageName)`.** The scanner now collapses repeated Dependabot alerts for one advisory and package (one per manifest) before writing, so a scan counts that finding once. No operator step is needed: the deploy hook (`.relay.yml` `post_update`) and `npm run db:push` run `prisma/pre-push/advisory-unique-key.sql` before `prisma db push`. The SQL removes existing duplicate rows (keeping the most complete one), recomputes the CVE counts and risk score of the affected scans, and creates the unique index under the name Prisma expects, so the push needs no `--accept-data-loss` and the deploy is not rolled back; it is a no-op on a fresh or already migrated database. The push also drops the now redundant single-column `scanId` index. A bare `prisma db push` still fails on a database that holds duplicates or lacks the index. `tests/unit/advisory-dedupe-db.test.ts` replays the exact hook commands (prisma 5.22.0, as the relay uses) against a Postgres seeded from the previous schema, with duplicates, with an empty table, on a fresh database and on a second deploy; it runs in the `Advisory dedupe (Postgres)` CI job and skips elsewhere unless `DEPSIGHT_TEST_DATABASE_URL` is set. Tracker task ec97f46f.

### Security

- **Per-repository PR-scan webhook secrets (task 4f058131):** the PR-scan webhook no longer uses one instance-wide secret, which let whoever held it sign deliveries for any repository tracked by any user and have depsight scan and comment under that user's GitHub token. Each tracked repository now has its own secret (`Repo.webhookSecretEnc`, two nullable columns, applied by the unchanged `prisma db push`), minted and rotated by the tracking user in Settings (`GET /api/webhook-secrets`, `POST` and `DELETE /api/webhook-secrets/[repoId]`, session only) and shown once. A delivery is verified against the secrets of the users who track the repository it names and acts only for the user whose secret verifies, so one user's secret never triggers a scan for another user's tracking row. Secrets are stored sealed with AES-256-GCM under a key derived from the new optional `WEBHOOK_SECRET_KEY` (falling back to `NEXTAUTH_SECRET`) and bound to their repository row. The replay guard and the per-repository rate limit are scoped to the verified row. `GET /api/webhook-secrets` reports per repository whether the stored secret is `usable` (opens under the current key material) and Settings asks the user to rotate one that is not (`available: false` in the same response, meaning no key material at all, shows an operator notice instead); the webhook logs one warning per affected row id, and one warning at the first delivery while `GITHUB_WEBHOOK_SECRET` is still set. `GITHUB_WEBHOOK_SECRET` is removed and ignored; no release ever read it. A GitHub webhook that still signs with an old shared secret answers 401 until the per-repository secret is entered in its Secret field. Tests: `tests/unit/webhook-secrets-route.test.ts`, `tests/unit/pr-webhook-secret.test.ts`.
- **next 15.5.27** (GHSA-mcj8-r9mp-w47p, GHSA-4jqv-mc3x-m676): the lockfile resolves 15.5.27 with its matching `@next/env` and `@next/swc-*` packages and the `next` dependency floor is now `^15.5.27`.
- **next 15.5.28** (GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r): the lockfile resolves 15.5.28 with its matching `@next/env` and `@next/swc-*` packages and the `next` dependency floor is now `^15.5.28`, superseding the 15.5.27 entry above.
- Workflow steps that print npm or npx output (`npm ci`, `npx prisma generate`, `npx tsc` in `ci.yml`; `npm ci`, `npm install -g`, `npm publish` in `publish-npm.yml`; the okf-kit install in `okf-staleness.yml`) now run through `scripts/ci/stop-commands-run.sh`, which prints the command's stdout and stderr between `::stop-commands::<token>` and its resume line with a per-run random token, so registry-influenced text cannot act as a workflow command (`::add-mask::`, `::set-output`, `::stop-commands::`). Problem matchers registered by `actions/setup-node` still apply to text inside the block. The step fails with exit 1, before running the command, when the token cannot be generated; the command's own exit status is otherwise the step's. The `Audit` report step keeps its inline block. Tests: `tests/unit/stop-commands-run.test.ts`. Tracker task 2061f572.
- The `Audit` workflow gate now classifies `npm audit --audit-level=high --json` with `scripts/audit-gate.mjs` (dependency-free Node 20, tests in `tests/unit/audit-gate.test.ts`) instead of grepping npm's human summary, and honours an ID-scoped, dated allowlist, `.github/audit-allowlist.json` (`{ id, reason, reviewBy }` per entry). An advisory is excepted by exact GHSA id (taken from the advisory url in npm's JSON, never by severity or package name), a package counts as excepted only when every HIGH/CRITICAL advisory in its dependency chain is allowlisted, and any other HIGH/CRITICAL advisory keeps the gate red. The four outcomes are unchanged (0 clean, 1 findings, 2 registry outage, 3 unclassified). An entry whose `reviewBy` date is before today (UTC) fails the gate with exit 1 even when the advisory is gone, an entry that matches nothing in a tree only warns, and a malformed allowlist (bad JSON, missing field, unknown key, bad id or date, duplicate id) is exit 3 naming the file. The one entry is GHSA-vfj7-8cjw-p6xm (braces 3.0.3, dev only via micromatch under eslint-config-next, no upstream fix), review date 2026-11-06. A `reviewBy` more than 90 days after today (UTC) is also rejected as a malformed allowlist (exit 3, naming the file and the id), and the unmatched-entry warning fires only for an id that appears in no advisory chain of the report. The script's entry-point check resolves symlinks on both sides, so the classification runs whatever path spelling invokes the script. Tracker task fc7c5ea2.
- The `Audit` gate hardening follow-ups to the allowlist gate: the workflow step now fails (exit 3) when `scripts/audit-gate.mjs` exits 0 without printing the `npm audit gate: CLEAN` line, so an invocation that never reached the classifier (a path to a different existing file, `node --import`; a missing script path already exits 1) can no longer turn the job green; a report whose `metadata.vulnerabilities` HIGH plus CRITICAL count disagrees with its `vulnerabilities` map, or that has no tally, is UNCLASSIFIED (exit 3) instead of being classified from the map alone; and npm's stderr is printed by the script, each line behind an `npm stderr| ` prefix, reduced to the script's safe character set, length and count bounded, so registry error text can no longer carry a workflow command (`::error::`, `::set-output`, `::stop-commands::`) into the log. The non-blocking `npm audit` report step prints npm's output between `::stop-commands::` and a per-run random resume token, so that output cannot carry a workflow command either (its `|| true` is unchanged). The script also prints the sanitised npm stderr on its early-exit paths (usage error, unreadable allowlist or capture). Copies of the script vendored into other repositories need the same update. Tracker task 5ba82b09.
- **body-parser 2.4.0** (GHSA-27r3-jxmh-p828): the lockfile resolves 2.4.0 (with content-type 2.1.0, iconv-lite 0.7.3 and qs 6.16.1, which it requires), so trailing bytes after a compressed request body no longer cause a denial of service.
- **fast-uri 3.1.9** (GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp): the lockfile resolves 3.1.9, which fixes scheme spoofing, host confusion, path equivalence and scheme injection in URI parsing. It is installed through `ajv`.
- **ip-address 10.7.4** (GHSA-rxp7-6hxx-x8q5): the lockfile resolves 10.7.4, which fixes quadratic-time matching of a zone identifier in `Address6`, so a long input string can no longer stall a process.
- **zod 4.6.7 (MCP package)** (GHSA-mrhx-c7xc-m3w5): the `mcp` package moves its `zod` dependency from `^3.22.0` to `^4.6.7` (the lockfile resolves 4.6.7, no nested 3.x remains); the advisory's memory-exhaustion fix ships only in the v4 core, and `@modelcontextprotocol/sdk` is unchanged (it accepts `^3.25 || ^4.0`). The tool argument schemas keep their accept-set and produced values (the CI lookback `period` moves from a numeric literal union to `z.literal([1, 7, 30])`, which publishes the same JSON Schema `enum`), so the only change in the published `inputSchema` is that the v4 converter drops the `additionalProperties: false` the v3 one added on objects, which zod never enforced at runtime (unknown keys are still stripped, not rejected).

### Fixed

- **The PR scan baseline ignores license and dependency scans, and the scan history returns the newest scans:** the PR scan compared open Dependabot alerts with the newest completed scan of any type, so after a license or dependency scan (which holds no advisories) every open alert was listed as new; the baseline is now the newest completed CVE scan, as in `GET /api/scan`. `GET /api/history` with more completed CVE scans than `limit` returned the oldest `limit`; it now returns the newest `limit`, still oldest first. The PR comment no longer says the alerts were introduced by the pull request (it words the result against the last CVE scan) and its overflow line no longer carries a placeholder link. The MCP missing-token error names the Settings page before the mint script, and `depsight_list_policies` is described as covering license, CVE and dependency rules. `.env.example`, the bug report template, `SECURITY.md` and the docs follow. Tracker task 0cda7b96.
- `scripts/check-docker-npm-coverage.ts` no longer skips (fails open on) the body of a RUN heredoc whose shell is reached through a wrapper or options: `env sh`, `sudo sh`, `command`, `exec`, `nice` and `time` (with their flags) and `VAR=val` prefixes are skipped, `bash -o pipefail`, `-eo pipefail`, `+o opt`, `--norc`, `-s` and `--` are accepted, a body piped into a shell (`cat <<EOF | sh`) is read, and an attached redirect (`<<EOF>/x`) is a marker. A body that is still not read (a non-shell consumer) and contains `npm install`, `npm i` or `npm ci` now gives a warning instead of passing silently. Tracker task 3c448be3.
- `scripts/check-docker-npm-coverage.ts` heredoc residuals: only leading RUN flags are dropped before the consumer check, so `RUN sudo --user node sh <<EOF`, `env --unset HOME sh` and `nice --adjustment 5 sh` are findings instead of warnings; the unread-body warning is anchored to the npm subcommand (`npm run test -- -i` no longer warns); the space-separated marker `<< 'EOF'` (also `<< EOF`, `<<- EOF`) is recognised; the heredoc consumer check shares one shell keyword set with the RUN splitter, and the header wording no longer claims the marker is exactly `<<WORD`. Tracker task a0364b72.
- Rust scans resolve a workspace member against the `Cargo.lock` next to its workspace root, as Cargo does, even when the member directory holds its own (stale) `Cargo.lock`. A member is a crate listed or globbed by an ancestor `[workspace]` `members` and not excluded (`exclude` entries are path prefixes, as in Cargo, and a non-glob `members` entry that names the directory exactly wins over `exclude`; Cargo also lets a non-glob entry naming a parent directory win, which is not modelled); supported globs are `*` and `?` within one path segment (for example `crates/*`). Not modelled: a `[ workspace ]` header with inner spaces, `package.workspace` pointers, implicit path-dependency members, and `**` as a whole segment (treated like `*`). A nested crate outside any workspace (for example `fuzz/`) keeps its own lock. Tracker task e56588cd.

## [0.8.0] - 2026-10-05

**Headline: per-user rate limits on the scan, sync and repository-listing routes, and the 429 is now surfaced instead of swallowed.** The published MCP package is released as `@opentriologue/depsight-mcp` 0.6.0 (tag `depsight-mcp-v0.6.0`): its client throws a dedicated `RateLimitError` (status 429, `retryAfterSeconds`) and the `depsight_rescan` error answer carries a `retryAfterSeconds` key; the server reports version 0.6.0 in the MCP handshake. depsight is deployed from `master`; this tag is deploy provenance.

### Added

- `scripts/check-docker-npm-coverage.ts`, a read-only standalone check (`npx tsx scripts/check-docker-npm-coverage.ts [--json] <repoDir>...`) for the npm 10 "edgesOut" crash class: it flags Dockerfiles that run a lockfile-less `npm install` in a builder with npm below 11 while a copied `package.json` carries `@vitest/coverage-v8`. Unknown builders count as findings, `--legacy-peer-deps` is reported as masked. Exit 0 no findings, 1 findings, 2 usage error. The human output and a JSON `reason` field give a short reason per finding (for example `lockfile bypassed: --no-package-lock, npm 10 < 11`). It understands RUN flags, RUN heredocs (BuildKit-style markers only; a body is read as shell text only for an empty or shell command, and a marker without a delimiter line gives a warning instead of swallowing the rest of the file), shell keywords, subshells and value-taking npm options, skips `.worktrees` directories, and does not read a copied `.npmrc` or COPY/ADD heredocs. It runs no docker, npm or network.

### Security

- Every route and server page that filters by the session user id now requires `session.user.id`, not just `session.user`: a signed-in session whose user row is gone has no id, and Prisma drops an `undefined` filter value, so `/api/webhooks`, `/api/slack`, `/api/dependabot*`, `/api/export`, `/api/pr-scan`, `/api/repos/sync`, `/overview`, `/dashboard` and `/policies` could query or (for `DELETE /api/slack`) delete rows of every user. They now answer 401 (pages redirect to `/login`).
- `POST /api/scan`, `POST /api/license`, `POST /api/deps` and `POST /api/ci/sync` are rate limited per user, session and `WRITE` token alike, so a looping `WRITE` token is capped at 300 scans, license scans, dependency analyses or per-repository syncs per hour (each its own budget), and at 12 all-repos syncs per hour. The limit counts requests, not GitHub API calls (one scan makes several). Over the limit they answer 429 with `Retry-After`; a request that fails authentication or the write-scope check is not counted. See `docs/api.md`.
- `GET /api/repos` is rate limited per user (300 per hour, its own budget), session and `dsat_` Bearer token of either scope alike, because a token spends its owner's GitHub quota there (one call lists the live repos with ceil(N/100) GitHub requests). Over the limit it answers 429 with `Retry-After`; a 401 is not counted. The counter is per app instance. See `docs/api.md`.

### Changed

- A per-user rate limit (429) is now shown instead of being swallowed. The dashboard "scan all" run stops on the first 429 from the scan, license or dependency step and shows how many seconds to wait (`retryAfterSeconds` from the body, else the `Retry-After` header, else 60); repositories scanned before the stop stay updated. The CI Health tab's sync button shows the same wait instead of the generic sync error. The MCP client throws a dedicated `RateLimitError` (status 429, `retryAfterSeconds`) and the `depsight_rescan` error answer carries a `retryAfterSeconds` key, so an agent can back off. New messages exist in German and English.

### Fixed

- `GET /api/sbom` accepts a `dsat_` Bearer token of either scope, so the MCP `depsight_get_sbom` tool no longer gets 401. `POST /api/ci/sync` accepts a `WRITE`-scoped token; a `READ` token gets 403. Both routes keep their owner scoping, and a session without a user id now gets 401 on `/api/sbom`.

### Docs

- The API reference lists which endpoints accept a Bearer token and which are session-only. The CI Health docs describe depsight's own GitHub Actions sync instead of an external service.

## [0.7.0] - 2026-10-04

**Headline: a completed scan now says why it was degraded, and a repository that cannot be read at all is no longer reported as a clean scan.** The deploy needs `prisma db push` (new nullable `Scan.degradedReason` column). The published MCP package is released as `@opentriologue/depsight-mcp` 0.5.0 (tag `depsight-mcp-v0.5.0`): the `depsight_rescan` answer carries a `degradedReason` key (null unless a source could not be read) and its message says so for a degraded scan (#153); the server reports version 0.5.0 in the MCP handshake. The mcp lockfile security bumps (ip-address, brace-expansion, fast-uri) only touch the repository's own dev and CI install; npm consumers do not receive them. depsight is deployed from `master`; this tag is deploy provenance.

### Added

- **`Scan.degradedReason`:** the CVE, license and dependency-age scanners record why a completed scan was degraded (the unreadable sources, cut to 500 characters without splitting a surrogate pair), null when every source was read. It is exposed as an additive `degradedReason` key by the `scan.completed` webhook payload, `POST /api/scan` (still `status: completed`), `GET /api/scan` and the MCP `depsight_rescan` answer, so a consumer can tell that a completed scan is partial. Which scan counts as the latest is unchanged (#153).

### Changed

- Publish workflows now install npm with `npm install -g npm@^11.5.1` (the documented trusted-publishing floor) instead of the floating `npm@11`. CI only; no package code change.
- CI: `release.yml` now passes step values into `run:` scripts through `env:` and shell variables instead of interpolating `${{ }}` expressions into the script text. No behavior change for normal tags and versions.

### Fixed

- A 404 on a repository's git tree or root listing is now confirmed once per scan against the repository lookup; when that also answers 404 the source is noted as "repository not readable" and the scan is marked degraded. A repository that exists but has no manifests stays a success (#152).
- Lockfile-only security bumps, no app or package code change: `ip-address` 10.4.0 to 10.7.2 in the mcp tree (GHSA-rpw4-54j3-4h4q, GHSA-2vr4-cq9g-pvrc, #154); `brace-expansion` and `fast-uri` to their patched releases in the app and mcp trees (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p, GHSA-hrr3-gc8f-f4qj, #156).

### Docs

- Known limitations now explain why a transitive-only advisory can be missing from a scan (the OSV channel queries manifest-declared dependencies only, and the Dependabot channel reports only alerts GitHub has already raised and that are open at scan time), name the fleet lockfile scan as the mitigation, and note that `state=all` is not a valid Dependabot alerts filter (#155). The README overview now says a transitive-only package surfaces once GitHub has raised a Dependabot alert (#157).

## [0.6.0] - 2026-09-29

**Headline: scanners now say when they cannot read their source, tokens carry a read/write scope, and the policy engine gains a version-floor type.** A scanner that could not read GitHub or OSV no longer reports a clean scan, each scanner carries its own freshness and failure marker, dsat_ tokens can be read-only, `DEPENDENCY_MIN_VERSION` policies enforce a per-package floor, Slack minimum severity MEDIUM/LOW finally delivers, and yarn.lock v1 repos are matched against resolved versions. The deploy needs `prisma db push` (new `ApiToken.scope` column and per-scanner freshness columns). The published MCP package is released as `@opentriologue/depsight-mcp` 0.4.0 (see the list below). depsight is deployed from `master`; this tag is deploy provenance.

**`@opentriologue/depsight-mcp` 0.4.0** (tag `depsight-mcp-v0.4.0`, npm trusted publishing), changes since 0.3.0: `depsight_list_repos` now carries depsight's own `repoId` beside GitHub's numeric `id`, joined on `githubId` through the new tracked-repo ids endpoint `GET /api/repos/tracked-ids`, with a `repoIdMergeUnavailable: true` marker when that lookup did not run (#136, #138); the tool descriptions list `DEPENDENCY_MIN_VERSION` and point callers at the `repoId` field (#124, #136); the `depsight_list_repos` description states that archived repos are excluded and that the returned `id` is GitHub's id (#126, #127); the server now reports version 0.4.0 in the MCP handshake. The mcp lockfile security bumps (#130, #131, #135) only touch the repository's own dev and CI install; npm consumers do not receive them.

### Added

- **`ApiToken` scope (READ vs. WRITE):** a dsat_ token now carries a
  `scope` (`ApiTokenScope.READ` or `WRITE`), defaulting to `WRITE` so
  every pre-existing token keeps today's full-access behaviour once the
  field is deployed (`prisma db push` backfills the column with its
  default, this repo has no migrations directory, so there is no
  separate migration to check). `resolveRequestUser()` (`lib/auth-api.ts`)
  now returns the resolved scope (a browser session always resolves to
  `WRITE`), and the policy CRUD write operations (`POST /api/policies`,
  `PUT /api/policies/[id]`, `DELETE /api/policies/[id]`) require `WRITE`,
  returning 403 for a `READ`-scoped token; the read operations (`GET`) are
  unaffected. The scan-triggering POSTs `/api/scan`, `/api/license`, and
  `/api/deps` require `WRITE` too, since each persists scan results and
  spends the repo owner's GitHub API quota; their `GET` counterparts stay
  open to both scopes. `POST /api/tokens` accepts an optional `scope` in
  the request body (still defaulting to `WRITE` when omitted, so callers
  that don't send it keep minting full-access tokens as before, and
  returning 400 for anything other than `READ`/`WRITE`), and the Settings
  token UI's create-token selector now defaults to `READ` (listed first)
  so a user who doesn't touch it mints a least-privilege token, and shows
  each existing token's scope in its list. `scripts/mint-api-token.ts`
  gained a matching `--scope READ|WRITE` flag (default `WRITE`, for
  compatibility with existing usage). This closes the gap where a leaked
  dsat_ token could delete or disable the policies that gate CI decisions
  (`LICENSE_DENY`, `CVE_MIN_SEVERITY`), or trigger scans that spend the
  owner's GitHub quota, even when the token was only meant to read.
- **`DEPENDENCY_MIN_VERSION` policy type:** expresses a per-package minimum
  version floor (rule shape `{ package: string, minVersion: string }`). The
  evaluator compares each matching dependency's installed version from the
  scan against the floor with semver and reports a violation per package
  below it; installed versions that are not valid semver are skipped and
  counted as unparseable rather than reported as a violation. `minVersion`
  is validated as a real semver version (and `package` as a non-empty
  string, normalized by trimming) when a `DEPENDENCY_MIN_VERSION` policy is
  created via `POST /api/policies`, or updated via `PUT /api/policies/[id]`
  -- whether that request sets `type` and `rule` together, sets only `rule`
  on a policy that is already `DEPENDENCY_MIN_VERSION`, or sets only `type`
  to `DEPENDENCY_MIN_VERSION` on a policy whose stored rule then has to
  satisfy the same shape -- so a malformed floor, or one left over from a
  policy's previous type, can no longer be saved as an enabled policy that
  silently checks nothing. Trimming the package name on the way in also
  keeps it from silently drifting out of sync with the evaluator's exact
  dependency-name match. The evaluator now also logs a warning when it
  skips unparseable installed versions, even when that skip leaves no
  violation to report.
- **Per-scanner freshness and failure markers** (task `d2995827`, #144): the
  cron used to stamp `Repo.lastScannedAt` after every non-rate-limited
  attempt even when all three scanners threw, so a persistently failing
  scanner sat behind an always-fresh "last scanned" time. Each scanner now
  stamps its own success time (`cveScannedAt`, `licenseScannedAt`,
  `depsScannedAt`) and keeps its last failure message (`cveScanError`,
  `licenseScanError`, `depsScanError`), cleared by its next success.
  `lastScannedAt` now means "any scanner last succeeded" and is no longer
  written by the cron; the cron records `lastScanAttemptAt` instead and its
  due-gate skips a repo touched by either, so the scan cadence is unchanged.
  The overview table and the dashboard header show a failure marker per
  failing scanner, and `GET /api/overview` gains an additive
  `scannerStatus` field. Requires `prisma db push` (new nullable columns, no
  backfill, so a scanner shows no success time until it next succeeds).
- **A scanner whose source cannot be read is marked degraded** (task
  `0f3559ba`, #149): the CVE, license and dependency-age scanners used to
  finish "clean" when GitHub or OSV could not be read (revoked token,
  outage), stamping a fresh success time and clearing the failure marker.
  Sources now report an unreadable read (anything but a 404 or an empty
  repository) to a per-scan tracker; the scanner still stores what it found
  but records the run through the per-scanner failure marker above and does
  not advance its last-success time or `lastScannedAt`. A 404 for a missing
  manifest or license file, a disabled Dependabot, and a per-package
  registry miss stay successes.
- **Slack messages show Mittel and Niedrig counts** (task `dfc5302f`,
  #150): when the channel's minimum severity is MEDIUM or LOW, the message
  carries Mittel and Niedrig count fields for the rows it lists.
- **`depsight_rescan` MCP tool** (#83, shipped in `@opentriologue/depsight-mcp`
  0.3.0): `depsight_rescan({ repoId })` posts to `/api/scan` with the
  configured `dsat_` token (it needs a `WRITE`-scoped token, see the
  `ApiToken` scope entry above) and returns `scanId` and `status`, so an
  agent can rescan and then poll `depsight_get_cves`.
- **Advisory source shown** (#97): `GET /api/scan` now serializes
  `Advisory.source` (`dependabot` or `osv`) and the advisory list renders a
  localized source badge per advisory; `depsight_get_cves` passes it through.
- **Lockfile-resolved CVE matching for `yarn.lock` v1** (#110): JS repos
  with a `yarn.lock` are matched against the resolved version instead of the
  manifest floor, like the `package-lock.json` and `uv.lock`/`poetry.lock`
  paths. When `package-lock.json` and `yarn.lock` disagree on a dependency,
  it falls back to the manifest floor rather than trusting either lockfile;
  yarn berry (v2+) lockfiles are detected by their `__metadata` marker and
  skipped, degrading to the manifest floor.
  `pnpm-lock.yaml` is not covered.

### Changed

- **Policy rules are validated for every PolicyType** (task `e3e9795f`):
  `POST /api/policies` and `PUT /api/policies/[id]` now check that `rule`
  fits the policy `type` for all five types and answer 400 with a message on
  mismatch (previously only `DEPENDENCY_MIN_VERSION` was checked). A PUT that
  sends `type` without `rule` now returns 400 when the stored rule does not fit
  the new type. Enabled policies whose stored rule fails the check (rows
  written before this change) log a warning on every evaluation; evaluation
  itself is unchanged and the rows are not migrated.
- **cve-sweep skill reduced to the depsight layer (2.0.0):** the skill now
  covers only what applies to every depsight user: MCP discovery
  (`depsight_get_overview`, `depsight_get_cves`), response shapes, and both
  channels' structural blind spots (Dependabot dev-scope auto-dismissal, OSV's
  direct-dependency-only query set) as mechanisms.
- **Slack minimum severity MEDIUM/LOW takes effect; webhooks unchanged**
  (task `0de0dd3c`, #146): the scanner prefiltered advisories to
  CRITICAL/HIGH before notifying, so a Slack minimum severity of MEDIUM or
  LOW never delivered anything. The prefilter is gone and each channel's
  threshold is applied by `notifyForScan`. Webhooks keep today's behaviour:
  only CRITICAL/HIGH advisories, and no delivery for a scan without one.
  The Slack message now lists advisories most severe first (stable sort) for
  every minimum-severity setting, so the top-3 slice never drops a CRITICAL
  or HIGH row for a lower one; the order and selection of the three listed
  rows in a CRITICAL/HIGH message can therefore differ from 0.5.1.
- **One license classifier for all ecosystems** (task `08b5630e`, #142): the
  copyleft set, the needs-review list and `classifyLicense` moved into
  `lib/license/classifier.ts`. The needs-review list is now `UNKNOWN`, empty,
  `SEE LICENSE IN LICENSE` and `UNLICENSED` everywhere, so Java gains
  `UNLICENSED` and the `SEE LICENSE` fallback, and PHP, Python and Rust gain
  the `SEE LICENSE` fallback. Java full-name matching, PyPI free-text
  normalization and Rust dual-license reduction still run first in their
  ecosystem files.
- **One shared severity ranking** for the policy engine and the notifier
  (task `d884dda4`, #141): refactor, no behaviour change.
- **Lockfile probing follows the tree walk** (#112): the scanner only
  fetches `package-lock.json` and `yarn.lock` paths that the existing tree
  walk observed, so a repo without a `yarn.lock` no longer costs blind 404
  probes; a truncated or failed walk keeps the old blind probing.
- **`@opentriologue/depsight-mcp` requires Node 20 and SDK 1.30**
  (#102, #109): `engines.node` is `>=20` (the locked tree resolves hono 2.x,
  which declares it) and the declared `@modelcontextprotocol/sdk` floor is
  `^1.30.0`, so a consumer whose own lockfile pins an older SDK no longer
  keeps the vulnerable hono.
- **Tests, docs, CI and tooling, no runtime behaviour change:** coverage
  gate and route, lib, CI-analytics and MCP tool tests (#86 to #91, #94),
  pinned `DEPENDENCY_MAX_AGE` boundary (#147) and displayed Python/Rust
  license values (#148); README restructure and `docs/roadmap.md` (#139),
  docs corrections (#116, #117, #118, #122), curated `docs/okf` knowledge
  bundle with a warn-only staleness check (#140), cve-sweep skill hardening
  (#101, #104, #106, #108, #114, #115, #133); `next-env.d.ts` untracked and
  unused test devDependencies dropped (#119), `.next` kept in a named volume
  in the dev container (#95); Node-24-capable Actions majors (#128), npm
  audit regression gate for both lockfile trees (#129), `npm ci --no-audit
  --no-fund` plus an audit gate that tells an endpoint outage from a finding
  (#132), tokenless npm trusted publishing for the MCP package (#120).

### Removed

- Operating-layer content (clone paths, token storage, branch/PR conventions,
  governance/routing, per-machine toolchain pinning, sweep history) from the
  cve-sweep skill: it now belongs in the consuming workspace's own skill
  layer, not in depsight's repo.
- The `verify-toolchain-forms.sh` script from the cve-sweep skill directory;
  toolchain verification is now the consuming workspace's concern.
- The detailed lockfile remediation procedure from the skill body; it now
  points to an external reference at
  https://github.com/LanNguyenSi/agent-dx/blob/master/packages/agentic-coding-playbook/references/npm-lockfile-cve-remediation.md

### Fixed

- **SBOM download filename** (#89): when the SBOM has no component name the
  download was named `sbom-sbom.cdx.json`; it is now `sbom.cdx.json`.
- **`depsight_list_repos` now carries depsight's own `repoId` alongside
  GitHub's numeric `id`** (task `33e80873`): the MCP tool returned only
  GitHub's numeric repo id, while `depsight_rescan` / `depsight_get_cves`
  (and every other `repoId`-taking tool) expect depsight's own id, only
  previously obtainable from `depsight_get_overview`; a caller piping
  the list output straight into `depsight_rescan` got a 404 "Repository
  not found" (reproduced against the live server before the fix).
  `mcp/src/tools/repos.ts` now fetches `/api/overview` alongside
  `/api/repos` and merges each overview entry's `repoId` into the
  matching list entry by `fullName`; GitHub's `id` is left untouched. An
  entry depsight tracks (added by the dashboard's Sync action or the sync
  cron; no scan required) carries `repoId`; an entry without `repoId` is
  not tracked yet and can only be added through depsight's own sync, not
  through `depsight_rescan` (`POST /api/scan` requires an existing
  `repoId`). The overview fetch is capped with a 5s timeout so a slow
  `/api/overview` degrades to "no `repoId` added" through the same path as
  an overview fetch failure, rather than stalling the whole list. Additive
  only: no existing field was renamed, and every other `depsight_*` tool's
  behavior is unchanged.

  `fullName` is a mutable, non-unique join key (depsight's `Repo` model is
  unique on `userId`+`githubId`; `fullName` only refreshes at sync, and the
  overview response carries no `githubId` today to join on instead, so the
  server-side fix is a separate follow-up, out of this task's scope). Round
  2 hardens the client-side join: when two overview entries share the same
  `fullName`, neither attaches a `repoId` to the matching list entry (never
  last-write-wins), and the match is case-sensitive (a case-differing
  `fullName` does not match). The tool description and README row now say
  so, plus the caveat that `repoId` is matched by full name at the time of
  depsight's last sync, so a rename-and-recreate on GitHub can leave it
  stale until the next sync. Round 3 makes the degrade observable: when the
  `/api/overview` leg failed, timed out, or came back in an unrecognised
  shape, the returned list now carries a top-level
  `repoIdMergeUnavailable: true` so a caller can tell "not tracked" apart
  from "the overview leg didn't run this call" instead of confusing the
  two; the key is absent when the merge ran normally. An ambiguous
  `fullName` still yields no `repoId` but is not flagged this way (the
  overview leg itself succeeded); the tool description and README row
  say so and point callers at `depsight_get_overview` to confirm either
  case. Superseded by the `githubId` join of task `ed7ddf84` below,
  before release. A malformed entry in
  `/api/repos`'s own `repos` array (`null` or a non-object) is now also
  returned unchanged instead of throwing inside the merge or being spread
  into character keys.

- **Repo sync now untracks archived GitHub repos:** the GitHub repo sync
  (`lib/repos/sync.ts`, used by `POST /api/repos/sync`) reads GitHub's
  `archived` flag and excludes archived repos from the active sync set,
  so they fall through the same "no longer tracked" path already used
  for repos that disappeared from GitHub: `tracked` flips to `false` on
  the next sync, scan history is never deleted, and once untracked the
  repo is excluded from new scans and policy evaluation (`lib/cve/scanner.ts`
  requires `tracked: true` to start a scan, and `evaluatePolicies()`
  requires `tracked: true` on the scan's repo). A repo whose `archived`
  field is missing or undefined from the GitHub API response is treated
  as not archived and stays tracked, so schema drift never silently
  untracks a repo; an API/network error during sync throws before any DB
  write, so nothing changes either. No new Prisma column: the existing
  `tracked` boolean already drives every scan/policy read, so no
  `prisma db push` is required for this change. `POST /api/repos/sync`
  also reports `archived` (repo count) alongside `synced`/`removed`.
  Archived repos are untracked on the next sync, including the hourly
  auto-scan sync (`instrumentation.ts` / `lib/cron/auto-scan.ts`). Not
  covered by this fix: a truncated GitHub repo LIST response (the
  paginated call stopping early) already, pre-existing, reads as those
  repos "no longer on GitHub" and untracks them via the same removal
  path, independent of the `archived` flag.

- **`GET /api/repos` and `POST /api/dependabot/enable-all` now respect
  the archived/untracked state that the repo sync fix above already
  applies:** `GET /api/repos` (the live GitHub list, also what the
  `depsight_list_repos` MCP tool surfaces) filters out repos where
  GitHub reports `archived: true`; pass `?includeArchived=true` to get
  the unfiltered list back. `POST /api/dependabot/enable-all` now scopes
  its repo lookup to `tracked: true`, so a `repoId` for an archived
  (and thus untracked) repo is silently skipped instead of attempting
  to enable Dependabot on it.

- **`depsight_list_repos`'s `repoId` merge now joins on GitHub's numeric
  id, and no longer pays for a full team-health computation to get it**
  (task `ed7ddf84`): the merge added by the `repoId` fix above (task
  `33e80873`) used `/api/overview` as its only source for depsight's own
  `repoId`, joined by `fullName` -- a mutable, non-unique key that two
  tracked repos can legitimately share, in which case neither got a
  `repoId` (never last-write-wins). A new cheap endpoint, `GET
  /api/repos/tracked-ids` (`lib/repos/tracked-ids.ts`), returns only each
  tracked repo's own `repoId` and GitHub's numeric `githubId` -- no CVE,
  license, dependency, or CI joins, and no call into
  `getTeamHealthOverview` (`lib/overview/team-health.ts`). `depsight_list_repos`
  now calls this endpoint instead of `/api/overview` and joins on
  `githubId`, depsight's `Repo` model's per-user-unique column, so two
  tracked repos sharing one `fullName` now each resolve to their own
  `repoId` instead of neither getting one. The 5s bound on the lookup and
  the `repoIdMergeUnavailable: true` degrade marker (set when the lookup
  fails, times out, or comes back in an unrecognised shape) are
  unchanged; existing response keys of both `/api/repos` and the MCP
  list tool are unchanged. `depsight_get_overview` is untouched and still
  calls `/api/overview` for the full team-health dashboard.

  What the list call now saves, counted from `getTeamHealthOverview`'s
  code path and measured on the live account (three sequential GETs each,
  34 tracked repos, warm server): the `/api/overview` leg the list call no
  longer makes cost 0.79-1.19s, against 0.47-0.71s for the plain `/api/repos`
  leg that runs either way; the new tracked-ids leg is one `repo.findMany` and
  was not measured before deployment. The old merge's `/api/overview` fetch ran that function's full aggregation
  -- 5 aggregate Prisma calls (`repo.findMany`, three `scan.findMany`
  queries for the latest CVE/license/deps scan per repo, and one
  `dependency.groupBy` for outdated counts) plus one `getCIPenalty`
  call per tracked repo (a `repo.findUnique` with a nested
  `workflows -> runs -> jobs` include, run in parallel via
  `Promise.all`) -- on every `depsight_list_repos` call, even though
  the list tool only ever read `repoId` and `fullName` off the result.
  The new endpoint runs exactly one `repo.findMany` regardless of
  tracked-repo count.

- **`/api/policies` and `/api/policies/[id]` accept a dsat_ Bearer token**: the policy CRUD routes were still session-only (`auth()`), so headless callers such as the MCP server got 401s. They now resolve the acting user via `resolveRequestUser()`, matching the rest of the API.
- **`PUT /api/policies/[id]` now always persists the validated `DEPENDENCY_MIN_VERSION` rule**: the write-back was previously gated on the request itself sending `rule`, so flipping a policy's `type` to `DEPENDENCY_MIN_VERSION` without resending `rule` (validating the stored rule against the new type) validated the stored rule but never wrote its normalized form back. An unnormalized rule left over from a copy-paste (a padded package name) could survive that flip untouched and never match the evaluator's exact `d.name === targetPackage` lookup, reporting clean forever. The route now writes `result.rule` unconditionally whenever the effective type is `DEPENDENCY_MIN_VERSION`, so every write path for this policy type persists the same validated value.
- **`DEPENDENCY_MIN_VERSION` package names now reject invisible characters and non-lowercase input** instead of silently storing them: zero-width characters (U+200B-U+200D, U+FEFF) survive `trim()` untouched, and npm package names are always lowercase, so a name like `PostCSS` or one carrying a zero-width character previously passed validation, got stored as-is, and never matched a real installed dependency name, reporting clean forever, the same failure class the existing trim was added to close. Both are now rejected with 400 (`package must not contain invisible characters` / `package must be a valid npm package name`) rather than silently accepted.
- **Correction to two measurements cited when `DEPENDENCY_MIN_VERSION` shipped**: `vitest.config.ts` has no per-file coverage floor for `lib/policy/engine.ts`; the second gated file (alongside `app/api/policies/[id]/route.ts`) is `app/api/policies/route.ts`. And the `PolicyList.tsx` semver import change did not remove the client-side semver chunk, it shrank it (measured 26,022 to 9,416 bytes; `semver/valid` still pulls in `parse`/`SemVer`/`re`); `/policies` First Load JS went from 118 kB (`origin/master`) to 127 kB and back down to 122 kB, not to a state where the chunk is gone.

- **Scan access failures return 403/404, duplicate running scans are
  guarded** (task `5e9a27bc`, #85, #93): `scanRepository` distinguishes
  not-found (404), not-owned (403) and not-tracked (404) instead of a
  generic 500, and returns the in-flight scan when a RUNNING scan exists for
  the repo within `SCAN_RUNNING_WINDOW_MS` (default 5 minutes) rather than
  spawning a duplicate that burns GitHub quota. The export route answers a
  clear 409 `scan_in_progress` in that case, and the `depsight_rescan`
  message says "already in progress".
- **OSV range shown is the one that matched** (#84, #92): the affected range
  shown for a CVE is the interval that contains the queried version, not
  always the first one; interleaved intervals in one range are walked in
  order and `last_affected` is an inclusive upper bound that never surfaces a
  fixed version.
- **Workspace version conflicts resolve to the worst case** (#98): specs are
  compared with `semver.minVersion` instead of a leading-digit regex, so
  x-ranges, hyphen ranges, OR ranges and pre-release tags no longer drop the
  more vulnerable pin; non-comparable specs (`workspace:`, `link:`, `npm:`,
  wildcards) never displace a comparable one.
- **npm lockfile conflicts and aliases** (#111): a bare name resolving to
  more than one distinct version across lockfile entries is dropped and falls
  back to the manifest floor, so a nested lower transitive can no longer
  silence a direct dependency's advisory; `npm:realName@range` aliases are
  queried under the real package name.
- **Unusable manifest floors reach the ambiguous fallback** (#113): a
  non-semver spec that contains a digit (such as a git spec) no longer counts
  as a usable floor and suppresses the fallback; the guard is
  `semver.valid(floor)`, and a range spec (such as `^19`) is also accepted
  through `semver.validRange`, using `semver.minVersion` as the floor.
- **Unknown dependency age is `null`, not `-1`** (task `d5639a62`, #145): the
  scanner already stored `null`, so the engine's `-1` check filtered nothing;
  the check and the schema comment now say `null`, and the policies route
  comments no longer claim the MCP server manages policies.

### Security

- **CVE sweep 2026-09-11** (task `729402b7-12a7-4075-8802-89b41be000c0`):
  closed a manifest-floor false-positive reported by depsight's own OSV
  channel: `postcss` GHSA-fxqj-rqcc-2cmp / CVE-2026-69153 (fixed 8.5.23)
  was flagged even though the root lockfile already resolved `postcss`
  8.5.23, because the OSV channel reads the declared manifest range, not
  the resolved lock version. `postcss`'s `devDependencies` range and the
  top-level `overrides.postcss` floor were both raised from `^8.5.18` to
  `^8.5.23` in `package.json`, then `package-lock.json` was regenerated
  with `npm install --package-lock-only` under npm 10.8.2 (Node 20.20.2,
  nvm); the `edgesOut` crash reported in earlier sweeps did not reproduce
  here, so no npm 11 fallback was needed. The only lockfile change is the
  mirrored `postcss` range string on the root package entry; the resolved
  `node_modules/postcss` version stays 8.5.23 and no nested record was
  added or removed. `mcp/` was not touched: its own lockfile has no direct
  `postcss` entry and its nested copy (`^8.5.26`) was already current;
  `npm audit --audit-level=moderate` stayed clean on both trees before and
  after.

- **CVE sweep 2026-09-09** (task `e8b5849a`): closed five advisories across
  six vulnerable packages (npm audit's count of 6) on the root lockfile by
  regenerating it within existing `package.json` ranges; no dependency
  range change was required for the fix:
  - `next` 15.5.21 -> 15.5.25 (GHSA-p293-qw3h-jr36, critical,
    unauthenticated RCE on windows-hosted servers; GHSA-2xp9-vwfh-vxw4,
    critical, RCE in the Image Optimization API via AVIF files), already
    within the `^15.5.15` range in `package.json`.
  - `sharp` 0.35.3 -> 0.35.4 (GHSA-rgj7-g3m4-5g8c, high, libheif
    vulnerabilities): 0.35.4 was already inside the existing `^0.35.3`
    override (semver `>=0.35.3 <0.36.0-0`), the lockfile was simply stale;
    the override floor was raised to `^0.35.4` deliberately as a regression
    guard, not because the fix needed it. `next` 15.5.25 itself now declares
    `sharp: ^0.34.3 || ^0.35.4`, so the override no longer gates the fixed
    version.
  - `js-yaml` 4.3.1 -> 4.3.2 (GHSA-2883-xcg3-v3hh, high, `maxTotalMergeKeys`
    does not limit CPU use for empty merge sources): a transitive
    dependency of `@eslint/eslintrc`, already within its declared
    `^4.3.0` range, no override needed.
  - `vitest` / `@vitest/mocker` / `@vitest/coverage-v8` 4.1.2 -> 4.1.11
    (GHSA-82fw-gwwq-j7x9, moderate, path traversal / arbitrary file read
    via `@vitest/mocker`'s redirect mock), already within the `^4.1.2`
    devDependency ranges.

  Lockfile regenerated with `npm update next sharp js-yaml vitest
  @vitest/mocker @vitest/coverage-v8 --package-lock-only` under npm
  10.8.2 (Node 20.20.2, nvm); no npm 11 fallback was needed, the
  `edgesOut` crash reported in earlier sweeps for lockfile-only resolves
  with `@vitest/coverage-v8` in the graph did not reproduce here. Side
  effects visible in the lockfile diff (13 entries added, 3 removed, 66
  changed, none across a major), among them: `vite` 8.0.16 -> 8.2.2 and
  `rolldown` 1.0.3 -> 1.2.7 (vitest's internal toolchain), the nested
  `picomatch` under `node_modules/vite` 4.0.4 -> 4.0.7 (the hoisted copy
  unchanged), `vite` now nesting its own `lightningcss` copy instead of
  sharing the hoisted one, `@oxc-project/types` 0.133.0 -> 0.148.0,
  `@emnapi/runtime` 1.10.0 -> 1.11.3 (its nested copy under
  `@img/sharp-wasm32` removed), `@img/sharp-libvips-*` 1.3.2 -> 1.3.3
  across the platform entries, `@rolldown/binding-wasm32-wasi` removed and
  `@rolldown/binding-android-arm-eabi` added.
  `mcp/` was not touched: its own audit gate (moderate-only, `hono` and
  the same `@vitest/mocker` advisory) was already green under
  `--audit-level=high` before this change and stays that way.

- **CVE sweep 2026-09-09, `mcp/` lockfile** (task `105be32b`): closed the
  four remaining moderate Dependabot alerts on `mcp/package-lock.json`
  left open after the root sweep above (the `Audit (mcp)` gate stayed
  green throughout, since it fails only on high/critical):
  - `hono` 4.13.0 -> 4.13.7 (GHSA-crvj-82cr-hjcx, query parser reads
    parameters after the URL fragment; GHSA-g6gw-c38x-mqfc, unbounded
    dot-notation nesting in `parseBody()`; GHSA-gqvv-2mrq-wpjv,
    incomplete fix for CVE-2026-39408, `toSSG()` still writes files
    outside the output directory), a transitive dependency of
    `@modelcontextprotocol/sdk` (`^4.11.4`), already within that range,
    no override needed.
  - `vitest` / `@vitest/mocker` / `@vitest/coverage-v8` 4.1.8 -> 4.1.11
    (GHSA-82fw-gwwq-j7x9, path traversal / arbitrary file read via
    `@vitest/mocker`'s redirect mock): `npm update` alone left these at
    4.1.8 despite the `^4.1.8` devDependency ranges admitting 4.1.11, so
    `vitest` and `@vitest/coverage-v8` were installed explicitly at
    4.1.11, which raised their declared ranges to `^4.1.11`; `@vitest/mocker`
    followed as a nested dependency of `vitest`.

  Lockfile regenerated in two steps under npm 11.19.1 (`npx npm@11`,
  Node 22.23.2 via nvm) after npm 10.8.2's `npm update` hit the known
  `Cannot read properties of null (reading 'edgesOut')` crash on this
  graph: `npm update hono vitest @vitest/mocker @vitest/coverage-v8
  --package-lock-only`, then `npm install vitest@4.1.11
  @vitest/coverage-v8@4.1.11 --package-lock-only`; verified afterwards
  with `npm ci` and `npm audit` under npm 10.8.2 (Node 20.20.2). No
  dependency crossed a major version. Lockfile delta: 1 entry added, 7
  removed, 47 changed, all `vitest`'s and `rolldown`'s own internal
  toolchain and platform binaries (`vite`, `rolldown`,
  `@oxc-project/types`, `lightningcss-*`, `@rolldown/binding-*`) plus
  `hono` itself; the `wasm32`/`emnapi` fallback entries for
  `@rolldown/binding-wasm32-wasi` were dropped and
  `@rolldown/binding-android-arm-eabi` was added by the newer
  `rolldown` release's platform matrix. Root `package.json` and
  `package-lock.json` were not touched.

- **SSRF guard blocks bracketed IPv6 literals synchronously** (#96):
  `new URL('http://[::1]').hostname` keeps its brackets, so `assertPublicUrl`
  skipped the literal-IP branch and only caught these hosts through the
  DNS-failure fallback. Brackets are stripped before the check, and
  `isPrivateIPv6` now also recognizes the compressed-hex form of IPv4-mapped
  addresses (`::ffff:a00:1`) that `URL` produces.
- **Earlier lockfile sweeps, 2026-07 to 2026-09-04** (#99, #100, #102, #103,
  #105, #107, #129, #130, #131): both root CRITICAL advisories closed (`@auth/core`
  and `next-auth`), npm audit findings resolved in root and
  `mcp/` (`postcss`, `next`, `sharp`, `body-parser`, `fast-uri`, `hono`,
  `brace-expansion`, `ip-address`, `undici`, `express-rate-limit`,
  `socket.io-parser`, `qs`, `@humanfs/node`), `js-yaml` 4.3.1 (GHSA-5p4m-2wfm-xmqj),
  `nanoid` 3.3.18 (GHSA-2v37-7h3g-55p8), and the
  `@hono/node-server` advisory GHSA-frvp-7c67-39w9 closed through SDK 1.30.0.

## [0.5.1] - 2026-06-25

**Headline: CVEs are now matched against the resolved lockfile version, not the manifest floor.** A scanner-correctness pass closes the gap between the version a manifest declares as a lower bound and the version actually locked, for both npm and Python projects. depsight is deployed from `master`; this tag is deploy provenance.

### Fixed

- **CVEs matched against the resolved lockfile version, not the manifest floor** (PR #79): npm/Node advisories are now evaluated against the version actually resolved in the lockfile rather than the lower bound declared in the manifest, removing false positives and negatives caused by the floor-vs-resolved gap.
- **Python CVEs resolved against `uv.lock`/`poetry.lock`, not the `pyproject` floor** (PR #80): the same resolved-version correctness for Python, reading the locked version from `uv.lock` or `poetry.lock` instead of the `pyproject.toml` floor.

### Docs

- **Dashboard hero screenshot added to the README** (PR #81).

## [0.5.0] - 2026-06-20

**Headline: OSV.dev added as a second CVE source, plus a UI hardening pass and the notification/policy pipeline wired end to end.** depsight is deployed from `master`; this tag is deploy provenance.

### Added

- **OSV.dev as a second CVE source** (PR #76): dependencies are now matched against OSV.dev in addition to GitHub Dependabot, so CVEs that Dependabot misses (it must be enabled per-repo, is capped, and covers Go/PyPI weakly) are caught. Cross-source dedup keys on (advisory id, package) and collapses OSV alias twins to the canonical record. Adds `Advisory.source` and `Scan.ecosystem`; CycloneDX SBOM PURLs are now ecosystem-aware, and a repo with a clean scan (no advisories) can export an SBOM.
- **Notification settings UI** (PR #73): Slack and outbound-webhook configuration now have a UI under Settings (previously reachable only via the API).
- **Content-list filters and dashboard deep links** (PR #73): severity/status filter chips plus text search on the advisory, dependency, and license lists; the dashboard's selected repo and active tab are reflected in the URL for deep links and Back/Forward.
- **scan.completed event and automatic post-scan policy evaluation** (PR #75): the scan.completed webhook event now fires for every scan, policy evaluation runs automatically after each scan, the license and dependency scanners now emit notifications, and the background cron syncs CI every cycle.
- **MCP v0.3.0** (PR #77): new read-only `depsight_list_policies` and `depsight_get_sbom` tools; the ci-analytics period input is now a numeric literal union.

### Fixed

- **Scanner correctness** (PR #74): Dependabot alerts now paginate (were capped at the first 100) with rate-limit-aware 403 handling, so a transient 403 no longer hides every advisory; Maven dependency age is computed from the installed version (`core=gav`) instead of the latest release; Go latest-version selection no longer assumes the proxy list is sorted; the cross-repo CI summary reports the real flaky-job count.
- **Cross-workspace dependency conflict** (PR #70): keep the lowest concrete version when two workspaces pin the same dependency to different specs.
- **i18n leaks** (PR #73): the CI Health tab and several dashboard strings were hardcoded; they are now localized, and timeline dates follow the active locale.

### Security

- **CVE sweep** (PR #69): vite and js-yaml advisories cleared.
- **hono bumped in `mcp/`** (PR #72) for the CORS advisory.

### Docs

- **README and docs drift fixes** (PR #71).

## [0.4.1] - 2026-06-16

**Headline: Security patch for esbuild CVE GHSA-g7r4-m6w7-qqqr across the app and the MCP sub-package.**

### Security

- **esbuild pinned to >=0.28.1 in the root manifest** (PR #66): added an `overrides` entry to constrain the optional peer dep range that vite brings in (`^0.27.0 || ^0.28.0`) to `>=0.28.1` (GHSA-g7r4-m6w7-qqqr).
- **esbuild pinned to >=0.28.1 in `mcp/`** (PR #67): the `mcp/` sub-package lockfile still resolved esbuild 0.27.7 via `tsx` and `vite`; bumped `tsx` to `^4.22.4` and added an `esbuild ^0.28.1` override (GHSA-gv7w-rqvm-qjhr, GHSA-g7r4-m6w7-qqqr).

## [0.4.0] - 2026-06-09

**Headline: monorepo and inherited-version support for the non-npm scanners (Java, Rust, and friends).** depsight now walks the full git tree for manifests and resolves versions inherited from a parent POM or a Cargo workspace, so a polyglot monorepo gets its deps and licenses resolved across every ecosystem instead of just the root. depsight is deployed from `master`; this tag is deploy provenance.

### Added

- **Full git-tree manifest discovery for monorepos** (PRs #59, #62). The scanners walk the entire git tree for manifests and union all manifest paths for the non-npm ecosystems, so deps and licenses resolve across a monorepo's sub-projects rather than only the repository root.
- **Java: versions resolved from the parent POM `<dependencyManagement>`** (PR #64), so a child module that omits an explicit version inherits it correctly.
- **Rust: `[workspace.dependencies]` inheritance resolved in `Cargo.toml` scanning** (PR #63), so workspace-inherited crate versions are recognised.

### Changed

- **Removed stale planforge / scaffoldkit bootstrap artifacts** (PR #58).

> The hono (#61) and vitest (#60) CVE bumps in this window were scoped to the `mcp/` package (`@opentriologue/depsight-mcp`), not the deployed app: hono is not an app dependency, and the app's vitest was already current. They are intentionally absent here. The `depsight-mcp` package is not re-released because consumers resolve hono via its `^4` range and vitest is a devDependency.

## [0.3.0] - 2026-05-31

**Headline: self-service API tokens and a hardened, agent-driven CVE
sweep.** You can now mint and revoke `dsat_` service tokens from the
Settings page instead of running a CLI, switch the UI language, and
drive an org-wide CVE sweep from a committed `/cve-sweep` skill that
sources discovery and triage straight from depsight's MCP. This release
also closes a HIGH audit finding (repo-ownership scoping plus an SSRF
guard) and clears a batch of dependency CVEs.

### Added

- **Settings page + user menu** (#55): manage `dsat_` API tokens from
  the UI (mint, view-once, revoke), backed by the existing `ApiToken`
  model, and relocates the UI language switch (English/German) into
  Settings.
- **`/cve-sweep` skill** (#56): a committed, model-invoked Claude Code
  skill at `.claude/skills/cve-sweep/` that runs the org CVE sweep off
  the depsight MCP (`depsight_get_overview` for discovery,
  `depsight_get_cves` for triage), then lockfile-first remediation one
  branch per repo with the governance routing.
- **Tag-driven npm publish for the MCP** (#54): pushing a
  `depsight-mcp-v*` tag publishes `@opentriologue/depsight-mcp` with
  provenance via `.github/workflows/publish-npm.yml`.
- **Open-source surface** (#45): LICENSE, Code of Conduct, contributing
  guide, security policy, and issue/PR templates.

### Changed

- **ESLint flat config** (#50): migrated off the deprecated `next lint`
  to a flat `eslint.config.mjs`.
- **Docs** (#44, #51): README 60-second hook and a restructure into
  `docs/`, plus an env-var reference table in `configuration.md`.
- **Config cleanup** (#52): dropped the unused `JWT_SECRET` config and
  the `jsonwebtoken` dependency.
- **Repo hygiene** (#48): gitignore `*.tsbuildinfo` and stop tracking
  `tsconfig.tsbuildinfo`.

### Security

- **Repo-ownership scoping + SSRF guard** (#53, HIGH audit): CI
  analytics endpoints now enforce repo ownership for the requesting
  user, and webhook/Slack URL inputs are validated against an SSRF
  guard before any outbound request.
- **Dependency CVE sweep** (#46): bumped `fast-uri`, `hono`,
  `ip-address`, and `express-rate-limit`.
- **postcss** (#47): pinned `>= 8.5.10` via override (GHSA-qx2v-qp2m-jg93).
- **qs** (#49): bumped to 6.15.2 in `mcp/` (CVE-2026-8723).

## [0.2.0] - 2026-04-17

**Headline: Agents can now talk to depsight.** New `depsight-mcp`
subpackage exposes the read API over MCP, with a service-token
(`dsat_`) auth path that sits alongside the existing NextAuth session
flow — so Claude and other agents can query overview / CVEs / license
/ CI analytics without scraping the UI or impersonating a user.

### Added

- **`@opentriologue/depsight-mcp` server** (`mcp/`) — stdio MCP
  server, npx-installable, zod + MCP SDK, vitest-covered. Mirrors the
  `ops-mcp` layout. Read-only tools: `depsight_list_repos`,
  `depsight_get_overview`, `depsight_get_cves` (filters by
  `minSeverity` + `publishedAfter`), `depsight_get_license_report`,
  `depsight_get_deps`, `depsight_get_history`,
  `depsight_evaluate_policy` (pure, no state mutation),
  `depsight_ci_analytics` (per-repo + cross-repo).
- **Service-token auth path** — new `lib/auth-api.ts`
  `resolveRequestUser()` helper. Tries NextAuth session first, then
  `Authorization: Bearer dsat_<token>` against the existing
  `ApiToken` Prisma model. Fails closed on non-`dsat_` prefixes,
  respects `revokedAt`, and stamps `lastUsedAt` fire-and-forget.
- **`scripts/mint-api-token.ts`** — CLI that mints a `dsat_` token
  for a given `userId`, prints the raw token once, and stores only
  the row. Redacts Prisma error details on failure.
- **MCP docs** (`mcp/README.md`) — Claude Desktop config, smoke
  test (real `tools/call` round-trip), token-minting procedure,
  v1 scope notes.

### Changed

- 8 MCP-consumed routes refactored to use `resolveRequestUser()`
  while preserving semantics for existing session callers:
  `/api/overview`, `/api/repos`, `/api/scan`, `/api/deps`,
  `/api/license`, `/api/history`, `/api/policies/evaluate`,
  `/api/ci/analytics` (both variants).

### Fixed

- **GitHub repo filter** — `getUserRepos` no longer pulls in
  repos the user is merely a collaborator on. Affiliation is now
  restricted to `owner` + `organization_member`, so dashboard
  counts and scans reflect repos the user actually owns.
- **Root tsconfig excludes `mcp/` + `scripts/`** — the MCP
  subpackage owns its own tsconfig and deps; `scripts/` runs via
  `tsx`. The root Next.js `tsc --noEmit` was pulling their files
  into the main type-check without their types, breaking CI.

## [0.1.0] - 2026-04-15

**Headline: First tagged release of depsight — a GitHub-connected
developer security dashboard for CVE tracking, license compliance,
dependency health, and CI insights across all your repos.**

This is the baseline release. Everything below describes what the
dashboard ships with today.

### Added

#### Core dashboard

- **`/overview` as post-login landing page** — unified dashboard view
  with a Sync button that triggers a fresh scan across all connected
  repos.
- **Dependency / CVE surface** — GitHub-connected inventory of
  dependencies and known vulnerabilities, with license compliance
  tracking (`spdx-license-list`, `spdx-satisfies`).
- **Cron-based auto-scan** — background scanner with a configurable
  interval so the dashboard stays fresh without manual pokes.
- **Scan-all** — kicks off a CI Insights sync fire-and-forget per
  repo alongside the dependency scan.

#### CI Insights integration

- **CI Health tab** — per-repo view of CI signals and historical
  failure patterns, integrated into the depsight surface.
- **Tab gating** — CI Health tab is hidden until CI data has been
  ingested for the repo; once data exists, an empty-state hint
  guides the user on how to start the first sync.
- **README docs** — CI Health section cross-links the upstream
  `ci-insights` project.

#### Ops & deployment

- **Traefik + agent-relay deployment** — `.relay.yml` descriptor
  consumed by `agent-relay`, `docker-compose.traefik.yml` as the
  deploy compose file, `compose exec` used by relay post-update
  hooks. Ephemeral Prisma-migration container with `openssl`
  installed, `HOME=/tmp`, using `traefik-public` network.
- **Health endpoint** — `/api/health` for liveness checks.
- **Dockerized dev commands** — quality-of-life scripts for local
  iteration.
- **Prettier config** committed for consistent formatting.

#### Tests & quality gates

- **Vitest** test suite with `happy-dom` + `@testing-library/react`
  + `@vitest/coverage-v8`.
- **CI test step** added alongside lint, typecheck, and build.

### Security

- Bump `next` to 15.5.15 to address **GHSA-q4gf-8mx6-v5v3** (high-severity
  Denial of Service via Server Components, affects `>=13.0.0 <15.5.15`).
  The App Router pages in this dashboard render via RSC, so the
  vulnerable code path was reachable. Same-minor patch, no functional
  changes expected.
- `vite` high-severity CVEs patched.
- `defu` prototype-pollution CVE — upgraded to 6.1.6.
- `brace-expansion` CVE patched.

### Release infrastructure

- This release introduces `.github/workflows/release.yml`, triggered
  on `v*` tags. It reuses the existing `ci.yml` via `workflow_call`,
  extracts this CHANGELOG section for the tagged version, and
  publishes the GitHub Release via `softprops/action-gh-release@v2`.
- `package.json` version remains at `0.1.0`.
