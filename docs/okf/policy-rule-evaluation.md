---
type: invariant
title: Policy rule evaluation - every type is shape-checked at write time, stored rows warn at evaluation
description: evaluatePolicies still breaks out of a PolicyType case with no violation when the stored rule fails its type guard, but validatePolicyRule now checks the rule shape of all five policy types on POST and PUT (PUT validates the resulting type and rule pair), and every evaluation logs a warning per stored row whose rule fails that check, so a malformed rule can no longer persist unnoticed through the API; rows stored before the check are not migrated.
tags: [policy, silent-failure, validation]
timestamp: 2026-09-29T05:43:06Z
sources:
  - lib/policy/engine.ts
  - app/api/policies/route.ts
  - app/api/policies/[id]/route.ts
  - docs/features.md
---

## One dispatcher, five guarded cases

`evaluatePolicies` (`lib/policy/engine.ts:176-356`) loops over a user's enabled policies and switches on `policy.type`. Every one of the five cases opens the same way: read the field(s) it needs out of the stored `rule` JSON, check them with a type guard, and `break` out of the case with no violation pushed when the guard fails: `isStringArray` for `LICENSE_DENY` (`:219-220`) and `LICENSE_ALLOW_ONLY` (`:240-241`), `isSeverity` for `CVE_MIN_SEVERITY` (`:261-262`), `isNumber` for `DEPENDENCY_MAX_AGE` (`:282-283`), and `isDependencyMinVersionRule` plus a `semver.valid` re-check for `DEPENDENCY_MIN_VERSION` (`:303-305`). None of these five `break` statements logs anything itself, and the evaluation result carries no field for a skipped policy; the signal for a broken stored row is the separate warning described below.

## Every type is checked before it is stored

`validatePolicyRule(type, rule)` (`lib/policy/engine.ts:136-174`) is the one write-time validator: it requires `rule` to be a non-null, non-array object and then applies, per type, the same guards the evaluation cases use: `deniedLicenses` as a string array for `LICENSE_DENY`, `allowedLicenses` as a string array for `LICENSE_ALLOW_ONLY`, `minSeverity` as an uppercase `Severity` for `CVE_MIN_SEVERITY`, and `maxAgeDays` as a finite number for `DEPENDENCY_MAX_AGE`. `DEPENDENCY_MIN_VERSION` delegates to `validateDependencyMinVersionRule` (`:104`), whose messages and package-name normalization are unchanged. It returns either an `error` message or the rule to persist.

`POST /api/policies` calls it after the generic object check (`app/api/policies/route.ts:64-68`) and answers 400 with the message on failure. `PUT /api/policies/[id]` validates whenever the request changes `type` or `rule` (`app/api/policies/[id]/route.ts:102-125`): with only `rule` it validates against the stored type, with only `type` it validates the STORED rule against the new type, and with both it validates the pair without fetching; a request that changes neither (name, severity, enabled) leaves the stored rule unvalidated and unchanged. The validated rule, which is the trimmed one for `DEPENDENCY_MIN_VERSION`, is always written back into the update. `createPolicy` and `updatePolicy` in `lib/policy/service.ts` are the only paths that write a rule (`togglePolicy` in the same file flips `enabled` only), so nothing else needs to call the validator.

## Rows stored before the check

Rows written before write-time validation existed, or by anything other than the API routes, are not migrated or rejected. Instead `evaluatePolicies` runs `validatePolicyRule` on every enabled policy it loads and logs one `console.warn` per failing row per evaluation (`lib/policy/engine.ts:206-214`), naming the type, policy name, id and the validation message. Evaluation itself is unchanged: the case still `break`s on a failed guard, and a `DEPENDENCY_MIN_VERSION` row that passes the guard but fails the stricter package-name grammar (below) warns and still evaluates. The warning is a server-side log line, not part of the API response, the same visibility the unparseable-installed-version warning has.

## The other warning covers a narrower case

`DEPENDENCY_MIN_VERSION` also logs mid-evaluation for a failure that happens *after* its rule has passed the type guard: an installed dependency version that isn't valid semver is skipped and counted, and if any were skipped a `console.warn` fires once per policy per scan (`lib/policy/engine.ts:323-329`). This unparseable-version skip/warning, and the requirement that `minVersion` itself be valid semver, are documented in the Policy engine section of `docs/features.md`; this doc does not repeat those two points. The same section also lists the write-time rule shapes and the stored-row warning.

`validateDependencyMinVersionRule` (`lib/policy/engine.ts:104-123`) also guards the package name itself before persisting a rule: it rejects a name that survives `trim()` but still carries a zero-width character (zero-width space/non-joiner/joiner, or a zero-width no-break space/BOM; `ZERO_WIDTH_RE`, `:69`) or that is not valid lowercase npm package-name grammar (`NPM_PACKAGE_NAME_RE`, `:80`), applying both checks at `:113-117`. Either defect would otherwise let a policy that looks accepted persist while never matching a real installed dependency name, the same silently-clean failure mode the semver checks exist to avoid.
