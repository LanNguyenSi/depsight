# Prompt: Multi-Ecosystem Support (Option B)

## Context

depsight is a GitHub-connected security dashboard (Next.js 15, Prisma/PostgreSQL).

Currently, license and dependency age scans only work for **npm/Node.js** repos (reads `package.json`, queries npm registry). For all other ecosystems (Python, Go, Java, etc.), the app shows an info banner: "Nur npm wird unterstützt."

**Goal:** Extend support to the most common ecosystems so that license and dep-age scans work for Python, Go, Java, Rust, and PHP repos as well.

---

## Existing Architecture

### Ecosystem detection
`lib/ecosystem.ts` — already detects ecosystem from root manifest files:
- `package.json` → npm ✅ (supported)
- `requirements.txt` / `pyproject.toml` / `Pipfile` → python ❌
- `go.mod` → go ❌
- `pom.xml` / `build.gradle` → java ❌
- `Cargo.toml` → rust ❌
- `composer.json` → php ❌

### Dependency info model (Prisma)
```prisma
model Dependency {
  name                String
  installedVersion    String
  latestVersion       String
  publishedAt         DateTime?
  latestPublishedAt   DateTime?
  ageInDays           Int?
  status              DepStatus  // UP_TO_DATE | OUTDATED | MAJOR_BEHIND | DEPRECATED | UNKNOWN
  isDeprecated        Boolean
  updateAvailable     Boolean
}
```

### License entry model
```typescript
interface LicenseEntry {
  packageName: string;
  version: string;
  license: string;        // SPDX identifier e.g. "MIT", "Apache-2.0", "GPL-3.0"
  isCompatible: boolean;
  policyViolation: boolean;
  needsReview: boolean;
}
```

### Current npm flow (reference implementation)
**Deps:** `lib/deps/age-checker.ts`
1. Read `package.json` via GitHub Contents API
2. For each dependency: query `https://registry.npmjs.org/{package}` to get latest version + publish date
3. Compute `ageInDays`, `status`, `updateAvailable`

**License:** `lib/license/detector.ts`
1. Read `package.json` via GitHub Contents API
2. For each dep: query `https://registry.npmjs.org/{package}/latest` to get `license` field
3. Classify as copyleft / compatible / needs-review

---

## What to implement

Add multi-ecosystem support. Each ecosystem needs two scanners:
1. **Dep age scanner** — reads the manifest, looks up each package in the registry, returns `DependencyInfo[]`
2. **License scanner** — same manifest, looks up license from registry, returns `LicenseEntry[]`

### Priority order (implement in this order)

#### 1. Python (PyPI)
- **Manifest:** `requirements.txt` or `pyproject.toml` (check both, prefer pyproject)
- **Registry API:** `https://pypi.org/pypi/{package}/json` — returns `info.version`, `info.license`, `releases` object
- **Version parsing:** requirements.txt uses `package==1.0.0`, `package>=1.0.0`, `package~=1.0.0` — extract package name and pinned version if present
- **pyproject.toml:** parse `[project] dependencies` array (format: `"requests>=2.28"`)
- **Latest version:** `info.version` from PyPI response
- **Publish date:** `releases[version][0].upload_time` (ISO string)
- **License:** `info.license` field (often SPDX, sometimes free text like "MIT License")
- **Deprecated:** PyPI doesn't have explicit deprecated flag — skip / set false

#### 2. Go (pkg.go.dev / Go proxy)
- **Manifest:** `go.mod` — parse `require` block
- **Format:** `require github.com/pkg/errors v0.9.1` or multi-line `require ( ... )`
- **Registry API:** `https://proxy.golang.org/{module}/@v/list` for versions, `https://pkg.go.dev/{module}` for license info
- **Simpler license approach:** Use GitHub Contents API to read the `go.mod` file, then for each module check `https://pkg.go.dev/{module}?tab=licenses` — but this requires HTML scraping. Better: use OSV.dev for vuln data and accept that license info may be partial for Go.
- **Recommended:** For Go, implement dep age (versions from proxy) but accept "License: UNKNOWN" with needsReview: true for all Go packages. Document this limitation.

#### 3. Java (Maven Central)
- **Manifest:** `pom.xml` — parse `<dependencies>` block
- **Registry API:** `https://search.maven.org/solrsearch/select?q=g:{groupId}+AND+a:{artifactId}&rows=1&wt=json`
- **Version:** `response.docs[0].latestVersion`
- **Latest publish date:** `response.docs[0].timestamp` (milliseconds since epoch)
- **License:** Maven Central search doesn't reliably return license. Use `https://repo1.maven.org/maven2/{groupPath}/{artifactId}/{version}/{artifactId}-{version}.pom` and parse `<licenses><license><name>` from the POM XML. Accept partial coverage.

#### 4. Rust (crates.io)
- **Manifest:** `Cargo.toml` — parse `[dependencies]` section
- **Format:** `serde = "1.0"` or `serde = { version = "1.0", features = [...] }`
- **Registry API:** `https://crates.io/api/v1/crates/{crate}` — returns `crate.max_stable_version`, `crate.updated_at`, `versions[].license`
- **Note:** crates.io requires a `User-Agent` header (e.g. `depsight/1.0`)
- **License:** `versions[0].license` — SPDX string (e.g. "MIT OR Apache-2.0")

#### 5. PHP (Packagist)
- **Manifest:** `composer.json` — parse `require` object (skip `require-dev` for now)
- **Registry API:** `https://repo.packagist.org/p2/{vendor}/{package}.json`
- **Version:** latest stable version from packages array
- **License:** `packages[name][0].license` — array of SPDX strings

---

## File structure to create

```
lib/
  ecosystem.ts          ← already exists, update `supported` field
  deps/
    age-checker.ts      ← already exists (npm), add dispatch logic
    python.ts           ← NEW: Python dep age scanner
    go.ts               ← NEW: Go dep age scanner
    java.ts             ← NEW: Java dep age scanner
    rust.ts             ← NEW: Rust dep age scanner
    php.ts              ← NEW: PHP dep age scanner
  license/
    detector.ts         ← already exists (npm), add dispatch logic
    python.ts           ← NEW: Python license scanner
    go.ts               ← NEW: Go license scanner (partial - needsReview: true)
    java.ts             ← NEW: Java license scanner
    rust.ts             ← NEW: Rust license scanner
    php.ts              ← NEW: PHP license scanner
```

---

## Integration points

### Update `lib/ecosystem.ts`
Change `supported: ecosystem === 'npm'` to `supported: ['npm', 'python', 'go', 'java', 'rust', 'php'].includes(ecosystem)` after implementing all scanners.

### Update `lib/deps/age-checker.ts`
After the `detectEcosystem` call, dispatch to the correct scanner:
```typescript
if (ecosystemInfo.ecosystem === 'python') return scanPythonDeps(accessToken, owner, repo);
if (ecosystemInfo.ecosystem === 'go') return scanGoDeps(accessToken, owner, repo);
// etc.
```

### Update `lib/license/detector.ts`
Same dispatch pattern.

---

## Constraints

- **No new dependencies** — use only `fetch` for registry calls, `@octokit/rest` for GitHub API (already installed)
- **TypeScript strict mode, no `any` types** — use `unknown` + type guards
- **Batch API calls** — max 10 concurrent requests per scan (use existing `BATCH_SIZE = 10` pattern from npm scanner)
- **Graceful degradation** — if a package lookup fails, return `status: 'UNKNOWN'` / `license: 'UNKNOWN'` instead of throwing
- **Rate limits** — add 50ms delay between batches for PyPI/Maven to avoid rate limiting
- **DE UI strings** — all user-facing text in German
- **Tests not required** for this PR (test coverage is a separate task)

---

## Acceptance criteria

- [ ] Python repos: clicking "📦 Deps" shows real dependency age data from PyPI
- [ ] Python repos: clicking "📋 Lizenzen" shows real license data from PyPI
- [ ] Go repos: clicking "📦 Deps" shows version/age data; license shows "Überprüfung nötig" for all packages
- [ ] Java repos: Dep age from Maven Central, license from POM files where available
- [ ] Rust repos: Full dep + license data from crates.io
- [ ] PHP repos: Dep + license data from Packagist
- [ ] EcosystemNotice banner is no longer shown for supported ecosystems
- [ ] npm behavior unchanged
- [ ] TypeScript strict, Lint + Build green

---

## Notes

- Go module paths contain slashes (`github.com/user/repo`) — encode correctly in proxy URLs: `encodeURIComponent(module).replace(/%2F/g, '/')`  is wrong — Go proxy uses the path directly but needs lowercase: use `module.toLowerCase()`
- crates.io User-Agent is required to avoid 403: add `'User-Agent': 'depsight/1.0 (https://github.com/LanNguyenSi/depsight)'`
- Maven groupId uses dots (`com.google.guava`) but paths use slashes (`com/google/guava`) — replace `.` with `/`
- PyPI version strings often have `==` prefix in requirements.txt — strip the operator to get the installed version
