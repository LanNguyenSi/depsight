---
type: invariant
title: Policy rule evaluation - every type silently no-matches on a bad rule shape
description: evaluatePolicies dispatches per PolicyType with a break on a failed type guard for every one of the five policy types, not only DEPENDENCY_MIN_VERSION; only DEPENDENCY_MIN_VERSION's rule shape is validated at creation/update time, and only its evaluation loop logs a warning, so the other four types can persist a malformed rule that reports clean forever with no signal anywhere.
tags: [policy, silent-failure, validation]
timestamp: 2026-09-27T14:58:04Z
sources:
  - lib/policy/engine.ts
  - app/api/policies/route.ts
  - app/api/policies/[id]/route.ts
  - docs/features.md
---

## One dispatcher, five silent breaks

`evaluatePolicies` (`lib/policy/engine.ts:127-296`) loops over a user's enabled policies and switches on `policy.type`. Every one of the five cases opens the same way: read the field(s) it needs out of the stored `rule` JSON, check them with a type guard, and `break` out of the case with no violation pushed when the guard fails: `isStringArray` for `LICENSE_DENY` (`:159-160`) and `LICENSE_ALLOW_ONLY` (`:180-181`), `isSeverity` for `CVE_MIN_SEVERITY` (`:201-202`), `isNumber` for `DEPENDENCY_MAX_AGE` (`:222-223`), and `isDependencyMinVersionRule` plus a `semver.valid` re-check for `DEPENDENCY_MIN_VERSION` (`:243-245`). None of these five `break` statements logs anything. A policy whose stored `rule` fails its guard therefore evaluates to "no violations" on every single scan, forever, indistinguishable in the API response from a scan that genuinely found nothing to flag.

## Only one type is checked before it can reach that state

`validateDependencyMinVersionRule` (`lib/policy/engine.ts:106-125`) is the only rule-shape validator in the file, and it only runs for `DEPENDENCY_MIN_VERSION`: on create (`app/api/policies/route.ts:65-71`) and on update, where it additionally has to resolve the *effective* type/rule pair across partial PUT bodies before validating (`app/api/policies/[id]/route.ts:120-141`). The other four policy types get only the generic, type-agnostic check at the API boundary; `rule` must be a non-null, non-array object, nothing about its fields (`app/api/policies/route.ts:60-62`, `app/api/policies/[id]/route.ts:83-86`). A `LICENSE_DENY` policy created with `{ deniedLicenses: "GPL-3.0" }` (a string, not an array) or a `CVE_MIN_SEVERITY` policy with `{ minSeverity: "critical" }` (lowercase) is accepted and persisted as-is; `isStringArray`/`isSeverity` then reject it silently on every future evaluation.

## The one warning that exists covers a narrower case

`DEPENDENCY_MIN_VERSION` is also the only case that logs anything mid-evaluation, and only for a narrower failure that happens *after* its rule has already passed the type guard above: an installed dependency version that isn't valid semver is skipped and counted, and if any were skipped a `console.warn` fires once per policy per scan (`lib/policy/engine.ts:262-269`). This unparseable-version skip/warning, and the requirement that `minVersion` itself be valid semver, are documented in the Policy engine section of `docs/features.md` (`:60-66`); this doc does not repeat those two points, only places them relative to the broader silent-break pattern above, which applies to all five policy types and has no equivalent warning for any of the other four.

`validateDependencyMinVersionRule` (`lib/policy/engine.ts:106-125`) also guards the package name itself before persisting a rule, and `docs/features.md` says nothing about this part: it rejects a name that survives `trim()` but still carries a zero-width character (zero-width space/non-joiner/joiner, or a zero-width no-break space/BOM; `ZERO_WIDTH_RE`, `:57-69`) or that is not valid lowercase npm package-name grammar (`NPM_PACKAGE_NAME_RE`, `:71-80`), applying both checks at `:111-120`. Either defect would otherwise let a policy that looks accepted persist while never matching a real installed dependency name, the same silently-clean failure mode the semver checks above exist to avoid.
