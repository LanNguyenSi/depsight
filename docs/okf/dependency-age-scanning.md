---
type: invariant
title: Dependency age scanning - a shared contract and a null-only stored unknown age
description: five ecosystems share one scanner signature and DependencyInfo shape while npm is scanned inline instead of through a dedicated file; every scanner uses a -1 unknown-age sentinel in memory and lib/deps/scanner.ts converts it to null before the only Dependency write, so a stored unknown age is always null, which the schema comment and the DEPENDENCY_MAX_AGE check both state.
tags: [dependencies, ecosystems, schema, policy]
timestamp: 2026-10-10T11:41:26Z
sources:
  - lib/deps/age-checker.ts
  - lib/deps/scanner.ts
  - lib/deps/go.ts
  - lib/deps/java.ts
  - lib/deps/php.ts
  - lib/deps/python.ts
  - lib/deps/rust.ts
  - lib/manifest-discovery.ts
  - lib/policy/engine.ts
  - prisma/schema.prisma
---

## One shared shape, five dedicated files, one inline fallback

`DependencyInfo` (`lib/deps/age-checker.ts:17-27`) is the return shape every ecosystem scanner produces. Five non-npm ecosystems each ship a dedicated file exporting the identical signature `scan<Eco>Deps(accessToken: string, owner: string, repo: string, manifestPaths: string[] = []): Promise<DependencyInfo[]>` (`lib/deps/go.ts:91`, `lib/deps/java.ts:89`, `lib/deps/php.ts:75`, `lib/deps/python.ts:63`, `lib/deps/rust.ts:64`), each backed by its own registry (Go proxy, Maven, Packagist, PyPI, crates.io respectively). `analyzeDepAge` dispatches to the matching one by detected ecosystem (`lib/deps/age-checker.ts:99-103`). npm has no equivalent file: it is the fallback branch inlined directly in `age-checker.ts` (`lib/deps/age-checker.ts:105-178`), which reads manifests via `fetchNpmManifests`/`unionNpmDeps` (`lib/manifest-discovery.ts:1029`, `lib/manifest-discovery.ts:172`) and queries the npm registry directly rather than delegating to a per-ecosystem module.

## The `-1` sentinel never reaches the database as `-1`

Every scanner, the five dedicated files and the inline npm branch alike, uses `ageInDays: -1` to mean "publish date unknown or unresolved": `lib/deps/go.ts:83`, `lib/deps/java.ts:58` and `lib/deps/java.ts:86`, `lib/deps/php.ts:63`, `lib/deps/python.ts:50`, `lib/deps/rust.ts:52`, and the inline npm branch's own default (`lib/deps/age-checker.ts:186`) and computed case (`lib/deps/age-checker.ts:153-155`, `installedPublishedAt ? Math.floor(...) : -1`). But `lib/deps/scanner.ts:50` rewrites that sentinel before the `Dependency.createMany` write: `ageInDays: d.ageInDays >= 0 ? d.ageInDays : null`. Every persisted `Dependency` row therefore has `ageInDays` as either a real day count or `null`, never `-1`.

`prisma/schema.prisma:188`'s field comment reads `ageInDays Int? // null = unknown (the scanner maps its -1 sentinel to null before writing)`, so it states what the column holds while naming the in-memory `-1` convention that exists only above the write path. A query for `ageInDays = -1` finds nothing because the "unknown" case is always stored as `null`. `lib/deps/scanner.ts:43` (`Dependency.createMany`) is the only write path for `Dependency` rows in the codebase (an `rg` for `dependency.create`, `upsert` and `update` finds no other), and the readers (`app/api/deps/route.ts:122`, `lib/export/repo-bundle.ts:259`, `lib/sbom/cyclonedx.ts:173`, the dashboard components) all treat `null` as unknown.

## The age check tests for null only

`lib/policy/engine.ts:274`'s `DEPENDENCY_MAX_AGE` filter reads `d.ageInDays !== null && d.ageInDays > maxAgeDays`. Because every persisted unknown age is `null`, the check needs no `-1` clause and an unknown age never triggers the policy. `tests/policy/engine.test.ts` covers this with `null` fixtures, including a case with a negative `maxAgeDays` (the write-time validator accepts any finite number), where a `!== -1`-only check would flag the unknown dependency because `null > -1` is true in JavaScript.
