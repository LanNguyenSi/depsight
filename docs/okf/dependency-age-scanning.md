---
type: invariant
title: Dependency age scanning - a shared contract, a schema comment that no longer matches storage
description: five ecosystems share one scanner signature and DependencyInfo shape while npm is scanned inline instead of through a dedicated file; every scanner's -1 unknown-age sentinel is converted to null before it reaches the database, so the Dependency.ageInDays schema comment ("-1 = unknown") describes the in-memory convention, not what is ever actually stored, and a policy check for -1 is effectively dead code against real scan data.
tags: [dependencies, ecosystems, schema, policy]
timestamp: 2026-09-27T14:34:51Z
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

`DependencyInfo` (`lib/deps/age-checker.ts:17-27`) is the return shape every ecosystem scanner produces. Five non-npm ecosystems each ship a dedicated file exporting the identical signature `scan<Eco>Deps(accessToken: string, owner: string, repo: string, manifestPaths: string[] = []): Promise<DependencyInfo[]>` (`lib/deps/go.ts:91`, `lib/deps/java.ts:89`, `lib/deps/php.ts:75`, `lib/deps/python.ts:63`, `lib/deps/rust.ts:64`), each backed by its own registry (Go proxy, Maven, Packagist, PyPI, crates.io respectively). `analyzeDepAge` dispatches to the matching one by detected ecosystem (`lib/deps/age-checker.ts:99-103`). npm has no equivalent file: it is the fallback branch inlined directly in `age-checker.ts` (`lib/deps/age-checker.ts:105-178`), which reads manifests via `fetchNpmManifests`/`unionNpmDeps` (`lib/manifest-discovery.ts:1020`, `lib/manifest-discovery.ts:171`) and queries the npm registry directly rather than delegating to a per-ecosystem module.

## The `-1` sentinel never reaches the database as `-1`

Every scanner, the five dedicated files and the inline npm branch alike, uses `ageInDays: -1` to mean "publish date unknown or unresolved": `lib/deps/go.ts:83`, `lib/deps/java.ts:58` and `lib/deps/java.ts:86`, `lib/deps/php.ts:63`, `lib/deps/python.ts:50`, `lib/deps/rust.ts:52`, and the inline npm branch's own default (`lib/deps/age-checker.ts:186`) and computed case (`lib/deps/age-checker.ts:153-155`, `installedPublishedAt ? Math.floor(...) : -1`). But `lib/deps/scanner.ts:34` rewrites that sentinel before the `Dependency.createMany` write: `ageInDays: d.ageInDays >= 0 ? d.ageInDays : null`. Every persisted `Dependency` row therefore has `ageInDays` as either a real day count or `null`, never `-1`.

`prisma/schema.prisma:120`'s own field comment, `ageInDays Int? // -1 = unknown`, describes the `DependencyInfo` in-memory convention above the write path, not what the column ever actually holds once `scanDependencies` has run. A reader who trusts the schema comment literally and queries for `ageInDays = -1` will find nothing, not because the "unknown" case doesn't occur, but because it is always stored as `null` instead.

## A defensive check with no live target

`lib/policy/engine.ts:226`'s `DEPENDENCY_MAX_AGE` filter reads `d.ageInDays !== null && d.ageInDays !== -1 && d.ageInDays > maxAgeDays`. Against data written by the normal `scanDependencies` pipeline, the `!== -1` half of that check never has anything to exclude: `null` already covers every "unknown" row from that path. It would only matter for a `Dependency` row inserted by some other write path (a fixture, a script, a future ingestion route) that persists `-1` directly instead of going through `lib/deps/scanner.ts:34`'s conversion; no such path was found in this scan of the codebase.
