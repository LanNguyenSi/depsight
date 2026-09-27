---
type: invariant
title: License classification - five independent copies, three different fallback lists
description: classifyLicense and its COPYLEFT_LICENSES set are defined separately in detector.ts (npm) and each of php.ts, java.ts, python.ts, and rust.ts, not shared from one location; the SPDX copyleft sets currently agree, but the "needs review" fallback list is not one shared list either; it has three different variants across the five files, and java.ts additionally matches full license names by substring, so none of the five is a drop-in stand-in for another. go.ts skips classification entirely by documented design.
tags: [licenses, ecosystems, duplication]
timestamp: 2026-09-27T15:13:26Z
sources:
  - lib/license/detector.ts
  - lib/license/go.ts
  - lib/license/java.ts
  - lib/license/php.ts
  - lib/license/python.ts
  - lib/license/rust.ts
---

## Five definitions, not one shared function

`classifyLicense` and the `COPYLEFT_LICENSES` set it checks against exist as five separate, independently written copies, one per ecosystem file that does classification at all: npm's `lib/license/detector.ts:42-63` (function) reading the set declared at `:32-40`, `lib/license/php.ts:24-38` reading `:14-22`, `lib/license/java.ts:32-55` reading `:6-14` plus the java-only `COPYLEFT_NAME_PATTERNS` at `:17-30`, `lib/license/python.ts:88-108` reading `:13-21`, and `lib/license/rust.ts:37-51` reading `:15-23`. Each file calls its own local function; none imports another's. `lib/license/go.ts:1-36` has none of this machinery at all: Go license detection is a documented limitation that always returns `license: 'UNKNOWN', needsReview: true` for every module, because reliable per-module Go license data would require scraping pkg.go.dev or a similar service rather than reading `go.mod`.

## The copyleft set agrees today; the fallback list does not

As verified at this scan, the five `COPYLEFT_LICENSES` sets (`detector.ts`, `php.ts`, `java.ts`, `python.ts`, `rust.ts`) list the identical 20 SPDX license identifiers in the identical order. That agreement is a fact about their current contents, not a structural guarantee: they are five separately maintained literals, so adding a license id to one file's set (a new AGPL/EUPL variant, for example) does not propagate to the other four.

Each file's classifier also decides which license strings are merely "unclassified, needs review" rather than a violation, and that list is not one shared list either; it has three distinct variants across the five files:

- `lib/license/detector.ts:52-58` (npm): `'UNKNOWN'`, empty, `'SEE LICENSE IN LICENSE'`, `'UNLICENSED'`: four values.
- `lib/license/php.ts:33-35`, `lib/license/python.ts:99-105`, and `lib/license/rust.ts:46-48`: `'UNKNOWN'`, empty, `'UNLICENSED'`: three values, missing `detector.ts`'s npm/SPDX-specific `'SEE LICENSE IN LICENSE'`.
- `lib/license/java.ts:49-52`: `'UNKNOWN'`, empty only: two values, missing both `'SEE LICENSE IN LICENSE'` and `'UNLICENSED'`.

A license value of exactly `'UNLICENSED'` is therefore flagged `needsReview` on four of the five ecosystems but not on Java's.

## Each ecosystem prepares the license string differently before classifyLicense

`java.ts` matches copyleft licenses by a full-name substring list, `COPYLEFT_NAME_PATTERNS` (`lib/license/java.ts:17-30`, checked inside `classifyLicense` at `:43-46`), with no counterpart in `detector.ts`, `php.ts`, `python.ts`, or `rust.ts`. This exists because Maven `<license>` blocks commonly carry a human-readable name ("GNU General Public License v2.0") rather than an SPDX identifier, unlike `package.json`'s `license` field or the other ecosystems' manifest formats.

`python.ts` takes a different approach to the same free-text problem: `normalizeLicense` (`lib/license/python.ts:23-86`) maps PyPI's free-text license strings to SPDX identifiers by exact (case-insensitive) match against a fixed table, `LICENSE_MAP`, before `classifyLicense` ever runs; the caller applies them in that order, `normalizeLicense` then `classifyLicense` (`lib/license/python.ts:158-159`). This is exact-match normalization upstream of classification, not the substring matching `java.ts` does inside classification itself: `python.ts`'s own `classifyLicense` (`:88-108`) has no substring matching of its own. The other three prepare the string in their own ways, none of them free-text normalization or substring matching: `rust.ts` reduces a dual-license `A OR B` expression to its most permissive part as ranked by `PERMISSIVE_RANK` (`lib/license/rust.ts:26-35`) with `selectMostPermissive` (`:53-72`, applied at `:121-122`), so `GPL-3.0 OR MIT` is classified as `MIT`, while a pair with no ranked part keeps the first (`GPL-3.0 OR LGPL-3.0` stays `GPL-3.0`); `php.ts` classifies only the first entry of the Composer license array (`lib/license/php.ts:94-98`); `detector.ts` (npm) classifies the registry's `license` string as returned (`lib/license/detector.ts:135-136`), and separately classifies the repository-level license from the GitHub licenses API (`:155`).

A behavior verified against one file's `classifyLicense` (its exact copyleft set, its fallback list, whether it does substring matching, whether anything normalizes its input first) does not describe any other file's without checking that file directly; the claims above were checked against each of the five files' current source as cited, not against every manifest format each ecosystem's registry could return.
