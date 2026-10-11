---
type: invariant
title: License classification - one shared classifier, per-ecosystem preparation
description: classifyLicense, the COPYLEFT_LICENSES set and the needs-review list are defined once in lib/license/classifier.ts and shared by npm, PHP, Java, Python and Rust, so the copyleft set and the fallback list cannot diverge per ecosystem; Java full-name substring matching, PyPI free-text normalization and Rust dual-license reduction stay in the ecosystem files and run before the shared classifier. go.ts skips classification entirely by documented design.
tags: [licenses, ecosystems, classifier]
timestamp: 2026-09-29T06:55:48Z
sources:
  - lib/license/classifier.ts
  - lib/license/detector.ts
  - lib/license/go.ts
  - lib/license/java.ts
  - lib/license/php.ts
  - lib/license/python.ts
  - lib/license/rust.ts
---

## One shared classifier

`classifyLicense`, the `COPYLEFT_LICENSES` set and the needs-review list (`NEEDS_REVIEW_LICENSES`) are defined once, in `lib/license/classifier.ts` (set at `lib/license/classifier.ts:13-21#"]) as ReadonlySet<string>;"`, needs-review list at `lib/license/classifier.ts:25-30#"'UNLICENSED',"`, function at `lib/license/classifier.ts:43-55#"policyViolation: false, needsReview: false"`). `lib/license/detector.ts` (npm, calls at `lib/license/detector.ts:107#"classifyLicense(detectedLicense)"` and `lib/license/detector.ts:126#"classifyLicense(repoLicense)"`), `lib/license/php.ts` (`lib/license/php.ts:73#"classifyLicense(detectedLicense)"`), `lib/license/java.ts`, `lib/license/python.ts` and `lib/license/rust.ts` all import it; none keeps its own copy. `lib/license/go.ts:1-36#"needsReview: true,"` has none of this machinery: Go license detection is a documented limitation that always returns `license: 'UNKNOWN', needsReview: true` for every module, because reliable per-module Go license data would require scraping pkg.go.dev or a similar service rather than reading `go.mod`.

The comparison is exact and case-insensitive after trimming: the input is trimmed and upper-cased, then looked up in the copyleft set (20 SPDX ids: the GPL, AGPL and LGPL families, MPL-2.0, EUPL-1.1/1.2, CDDL-1.0/1.1, OSL-3.0, EPL-1.0/2.0), which is a policy violation, and then in the needs-review list. Anything else is compatible. Because there is one copy, adding a license id to the set reaches every ecosystem at once.

## One needs-review list

Strings that are merely "unclassified, needs review" rather than a violation are the same for every ecosystem: `'UNKNOWN'`, empty, `'SEE LICENSE IN LICENSE'` and `'UNLICENSED'` (`lib/license/classifier.ts:25-30#"'UNLICENSED',"`). Before the shared list existed the five copies had three variants (npm four values, PHP/Python/Rust three without `'SEE LICENSE IN LICENSE'`, Java two without `'UNLICENSED'` either), so the shared list is the union: Java now flags `'UNLICENSED'` and `'SEE LICENSE IN LICENSE'`, and PHP, Python and Rust now flag `'SEE LICENSE IN LICENSE'`, as `needsReview`. `tests/unit/license-classifier.test.ts` runs the same id table through every ecosystem's entry point.

## Each ecosystem prepares the license string before the shared classifier

The preparation stays in the ecosystem files and runs first; the classifier itself does no substring matching or free-text mapping.

`java.ts` matches copyleft licenses by a full-name substring list, `COPYLEFT_NAME_PATTERNS` (`lib/license/java.ts:11-24#"'Open Software License',"`), inside `classifyJavaLicense` (`lib/license/java.ts:30-36#"return classifyLicense(license);"`), which returns the copyleft classification on a substring hit and otherwise defers to the shared `classifyLicense`. This exists because Maven `<license>` blocks commonly carry a human-readable name ("GNU General Public License v2.0") rather than an SPDX identifier, unlike `package.json`'s `license` field or the other ecosystems' manifest formats.

`python.ts` maps PyPI's free-text license strings to SPDX identifiers by exact (case-insensitive) match against a fixed table, `LICENSE_MAP`, in `normalizeLicense` (`lib/license/python.ts:17-76#"return LICENSE_MAP[upper] ?? trimmed;"`), before the shared classifier runs; `resolvePythonLicense` (`lib/license/python.ts:79-82#"return { license, classification: classifyLicense(license)"`) applies them in that order and returns both the normalized value and its classification; the scanner takes the displayed `license` and the classification from that one call (`lib/license/python.ts:136#"const resolved = resolvePythonLicense(rawLicense);"`), and `classifyPythonLicense` (`lib/license/python.ts:84-86#"return resolvePythonLicense(raw).classification;"`) exposes the classification alone. This is exact-match normalization, not substring matching.

The other ecosystems prepare the string in their own ways, none of them free-text normalization or substring matching: `rust.ts` reduces a dual-license `A OR B` expression to its most permissive part as ranked by `PERMISSIVE_RANK` (`lib/license/rust.ts:16-26#"'Zlib': 8,"`) with `selectMostPermissive` (`lib/license/rust.ts:41-57#"return best;"`), inside `resolveRustLicense` (`lib/license/rust.ts:29-32#"return { license, classification: classifyLicense(license)"`), which returns the reduced value and its classification (the scanner uses both from that one call at `lib/license/rust.ts:106#"const resolved = resolveRustLicense(spdxLicense);"`; `classifyRustLicense`, `lib/license/rust.ts:34-36#"return resolveRustLicense(spdxExpression).classification;"`, exposes the classification alone), so `GPL-3.0 OR MIT` is classified as `MIT`, while a pair with no ranked part keeps the first (`GPL-3.0 OR LGPL-3.0` stays `GPL-3.0`); `php.ts` classifies only the first entry of the Composer license array (`lib/license/php.ts:68-73#"const classification = classifyLicense(detectedLicense);"`); `detector.ts` (npm) classifies the registry's `license` string as returned (`lib/license/detector.ts:106-107#"const classification = classifyLicense(detectedLicense);"`), and separately classifies the repository-level license from the GitHub licenses API (`lib/license/detector.ts:126#"const classification = classifyLicense(repoLicense);"`).

A behavior verified for one ecosystem's entry point (whether anything prepares its input first, and how) does not describe another's without checking that file directly; the claims above were checked against each file's current source as cited, not against every manifest format each ecosystem's registry could return.
