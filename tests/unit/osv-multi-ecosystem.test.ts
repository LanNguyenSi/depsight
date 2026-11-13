/**
 * The OSV channel queries every supported ecosystem a repo contains, each with
 * its own OSV ecosystem name, not only the primary one. The REAL pipeline
 * (detectEcosystem -> collectDeps -> OSV querybatch) runs on a synthetic
 * repository; only the GitHub client and `fetch` are mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

// Lets one test make the PHP dependency collection throw (a real read failure
// is swallowed per file by fetchManifestContents, so it cannot be provoked
// through the GitHub mock).
const phpCollect = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/manifests/php', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifests/php')>();
  return {
    ...actual,
    collectPhpDeps: (...args: Parameters<typeof actual.collectPhpDeps>) => {
      if (phpCollect.fail) throw new Error('php collect boom');
      return actual.collectPhpDeps(...args);
    },
  };
});

import { fetchOsvAdvisories, osvScanTargets } from '@/lib/cve/osv';
import type { EcosystemInfo } from '@/lib/ecosystem';
import { detectEcosystem } from '@/lib/manifest-discovery';
import { trackDegraded } from '@/lib/scan/degraded';
import { loadRepo, type Scenario } from './helpers/npm-repo-fixture';

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: 'p', dependencies: deps });
const composer = (require: Record<string, string>) => JSON.stringify({ require });

/** Eight root-level npm sub-projects, as in the repo that exposed the gap. */
const NPM_PROJECTS: Record<string, string> = Object.fromEntries(
  Array.from({ length: 8 }, (_, i) => [`app-${i}/package.json`, pkg({ lodash: '4.17.20' })]),
);
const PHP_PROJECT: Record<string, string> = {
  'notification-service/composer.json': composer({
    php: '>=8.1',
    'symfony/http-kernel': '6.4.1',
    'monolog/monolog': '3.5.0',
  }),
  'notification-service/composer.lock': JSON.stringify({ packages: [] }),
};

interface Query {
  ecosystem: string;
  name: string;
  version: string;
}

/**
 * Stub `fetch`: records every querybatch query and vuln-detail request.
 * `hits` maps `ecosystem:name` to the vuln id OSV reports for it;
 * `failEcosystem` makes the querybatch for that OSV ecosystem answer 503.
 */
function stubOsv(hits: Record<string, string> = {}, failEcosystem?: string) {
  const queries: Query[] = [];
  const batches: number[] = [];
  const detailIds: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes('querybatch')) {
        const body = JSON.parse(init!.body!) as {
          queries: Array<{ package: { name: string; ecosystem: string }; version: string }>;
        };
        batches.push(body.queries.length);
        for (const q of body.queries) {
          queries.push({ ecosystem: q.package.ecosystem, name: q.package.name, version: q.version });
        }
        if (failEcosystem && body.queries.some((q) => q.package.ecosystem === failEcosystem)) {
          return { ok: false, status: 503, json: async () => ({}) };
        }
        return {
          ok: true,
          json: async () => ({
            results: body.queries.map((q) => {
              const id = hits[`${q.package.ecosystem}:${q.package.name}`];
              return id ? { vulns: [{ id }] } : {};
            }),
          }),
        };
      }
      const id = decodeURIComponent(u.split('/vulns/')[1]);
      detailIds.push(id);
      const [ecosystem, name] = Object.entries(hits)
        .find(([, v]) => v === id)![0]
        .split(/:(.*)/s)
        .slice(0, 2);
      return {
        ok: true,
        json: async () => ({
          id,
          summary: `advisory ${id}`,
          database_specific: { severity: 'HIGH' },
          affected: [
            {
              package: { ecosystem, name },
              ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '9.9.9' }] }],
            },
          ],
        }),
      };
    }),
  );
  return { queries, batches, detailIds };
}

async function scan(scenario: Scenario) {
  loadRepo(scenario);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await trackDegraded(() => fetchOsvAdvisories('t', 'o', 'r', 'main'));
  } finally {
    warn.mockRestore();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  phpCollect.fail = false;
});

describe('OSV channel covers every supported ecosystem of a repo', () => {
  it('queries Packagist for a nested composer project beside root-level npm projects', async () => {
    const osv = stubOsv();
    await scan({ files: { ...NPM_PROJECTS, ...PHP_PROJECT } });

    const packagist = osv.queries.filter((q) => q.ecosystem === 'Packagist');
    expect(packagist.map((q) => `${q.name}@${q.version}`).sort()).toEqual([
      'monolog/monolog@3.5.0',
      'symfony/http-kernel@6.4.1',
    ]);
    expect(osv.queries.filter((q) => q.ecosystem === 'npm').map((q) => q.name)).toEqual(['lodash']);
  });

  it('negative control: without a composer project there is no Packagist query', async () => {
    const osv = stubOsv();
    await scan({ files: { ...NPM_PROJECTS } });

    expect(osv.queries.filter((q) => q.ecosystem === 'Packagist')).toEqual([]);
    expect(osv.queries.map((q) => q.ecosystem)).toEqual(['npm']);
  });

  it('a repo with one ecosystem sends the same single querybatch as before', async () => {
    const osv = stubOsv();
    const result = await scan({ files: { ...NPM_PROJECTS } });

    expect(osv.batches).toEqual([1]);
    expect(osv.queries).toEqual([{ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }]);
    expect(result.degraded).toBeNull();
    expect(result.value.ecosystem).toBe('npm');
  });

  it('advisories carry the real ecosystem, the primary stays the returned label', async () => {
    stubOsv({ 'npm:lodash': 'GHSA-npm', 'Packagist:symfony/http-kernel': 'GHSA-php' });
    const { value } = await scan({ files: { ...NPM_PROJECTS, ...PHP_PROJECT } });

    expect(value.ecosystem).toBe('npm');
    const byPackage = Object.fromEntries(
      value.advisories.map((a) => [a.packageName, a.ecosystem]),
    );
    expect(byPackage).toEqual({ lodash: 'npm', 'symfony/http-kernel': 'php' });
    expect(value.advisories.find((a) => a.ecosystem === 'php')?.fixedVersion).toBe('9.9.9');
  });

  it('fetches the details of a vuln id shared by two ecosystems once', async () => {
    const osv = stubOsv({ 'npm:lodash': 'GHSA-shared', 'Packagist:monolog/monolog': 'GHSA-shared' });
    // hits maps by id for detail lookup, so the shared id resolves to the first entry
    const { value } = await scan({ files: { ...NPM_PROJECTS, ...PHP_PROJECT } });

    expect(osv.detailIds).toEqual(['GHSA-shared']);
    expect(value.advisories.map((a) => a.ecosystem).sort()).toEqual(['npm', 'php']);
  });

  it('a primary ecosystem OSV cannot query does not hide a supported secondary one', async () => {
    const osv = stubOsv();
    await scan({ files: { Gemfile: 'source "https://rubygems.org"', ...PHP_PROJECT } });

    expect(osv.queries.every((q) => q.ecosystem === 'Packagist')).toBe(true);
    expect(osv.queries).toHaveLength(2);
  });

  it('a failing secondary ecosystem is reported under its name and keeps the primary result', async () => {
    stubOsv({ 'npm:lodash': 'GHSA-npm' }, 'Packagist');
    const { value, degraded } = await scan({ files: { ...NPM_PROJECTS, ...PHP_PROJECT } });

    expect(degraded).toContain('OSV querybatch (php): HTTP 503');
    expect(value.advisories.map((a) => a.packageName)).toEqual(['lodash']);
  });

  it('a secondary ecosystem whose dependency collection throws does not drop the primary result', async () => {
    phpCollect.fail = true;
    stubOsv({ 'npm:lodash': 'GHSA-npm' });
    const { value, degraded } = await scan({ files: { ...NPM_PROJECTS, ...PHP_PROJECT } });

    expect(degraded).toContain('OSV dependency collection (php): php collect boom');
    expect(value.advisories.map((a) => a.packageName)).toEqual(['lodash']);
  });

  it('a primary ecosystem whose dependency collection throws does not drop the secondary result', async () => {
    phpCollect.fail = true;
    stubOsv({ 'npm:lodash': 'GHSA-npm' });
    // composer.json at the root makes php the primary ecosystem
    const { value, degraded } = await scan({
      files: { 'composer.json': composer({}), 'web/package.json': pkg({ lodash: '4.17.20' }) },
    });

    expect(value.ecosystem).toBe('php');
    expect(degraded).toContain('OSV dependency collection: php collect boom');
    expect(value.advisories.map((a) => a.packageName)).toEqual(['lodash']);
  });

  it('a failing primary ecosystem keeps the plain label and the secondary result', async () => {
    stubOsv({ 'Packagist:symfony/http-kernel': 'GHSA-php' }, 'npm');
    const { value, degraded } = await scan({ files: { ...NPM_PROJECTS, ...PHP_PROJECT } });

    expect(degraded).toContain('OSV querybatch: HTTP 503');
    expect(degraded).not.toContain('(npm)');
    expect(value.advisories.map((a) => a.packageName)).toEqual(['symfony/http-kernel']);
  });
});

describe('detectEcosystem manifestPathsByEcosystem', () => {
  it('lists the supported ecosystems, with the primary one equal to manifestPaths', async () => {
    loadRepo({
      files: {
        'package.json': pkg({}),
        'svc/composer.json': composer({}),
        'tool/go.mod': 'module x\n',
        'Gemfile': '',
      },
    });
    const info = await detectEcosystem('t', 'o', 'r', 'main');

    expect(info.ecosystem).toBe('npm');
    expect(info.manifestPaths).toEqual(['package.json']);
    expect(info.manifestPathsByEcosystem).toEqual({
      npm: ['package.json'],
      php: ['svc/composer.json'],
      go: ['tool/go.mod'],
    });
  });

  it('a single-ecosystem repo has one entry', async () => {
    loadRepo({ files: { ...NPM_PROJECTS } });
    const info = await detectEcosystem('t', 'o', 'r', 'main');

    expect(Object.keys(info.manifestPathsByEcosystem ?? {})).toEqual(['npm']);
    expect(info.manifestPathsByEcosystem?.npm).toEqual(info.manifestPaths);
  });

  it('a large npm monorepo does not push a nested composer project past the manifest cap', async () => {
    loadRepo({ files: { 'package.json': pkg({}), ...PHP_PROJECT }, extraManifests: 120 });
    const info = await detectEcosystem('t', 'o', 'r', 'main');

    expect(info.manifestPaths).toHaveLength(100);
    expect(info.manifestPathsByEcosystem?.php).toEqual(['notification-service/composer.json']);
    expect(info.observedTreeFacts?.manifestsCapped).toBe(true);
  });

  it('a repo below the cap is not reported as capped', async () => {
    loadRepo({ files: { 'package.json': pkg({}), ...PHP_PROJECT }, extraManifests: 10 });
    const info = await detectEcosystem('t', 'o', 'r', 'main');

    expect(info.observedTreeFacts?.manifestsCapped).toBe(false);
  });
});

describe('osvScanTargets', () => {
  const info = (over: Partial<EcosystemInfo>): EcosystemInfo => ({
    ecosystem: 'npm',
    manifestFile: 'package.json',
    supported: true,
    manifestPaths: ['package.json'],
    observedLockfilePaths: null,
    ...over,
  });

  it('without a per-ecosystem map it is the primary ecosystem alone', () => {
    expect(osvScanTargets(info({}))).toEqual([
      { eco: 'npm', osvEco: 'npm', manifestPaths: ['package.json'] },
    ]);
  });

  it('without a per-ecosystem map an unsupported primary yields nothing, whatever its paths', () => {
    expect(
      osvScanTargets(info({ ecosystem: 'ruby', supported: false, manifestPaths: ['Gemfile'] })),
    ).toEqual([]);
  });

  it('without a per-ecosystem map an info flagged unsupported is not scanned, as before', () => {
    expect(osvScanTargets(info({ supported: false }))).toEqual([]);
  });

  it('the per-ecosystem map wins over manifestPaths, and unsupported keys are dropped', () => {
    const targets = osvScanTargets(
      info({
        manifestPathsByEcosystem: { php: ['a/composer.json'], ruby: ['Gemfile'] },
      }),
    );
    expect(targets.map((t) => [t.eco, t.osvEco])).toEqual([['php', 'Packagist']]);
  });

  it('the primary ecosystem comes first, the rest by manifest precedence', () => {
    const byEco = { php: ['c.json'], npm: ['package.json'], python: ['pyproject.toml'] };
    expect(
      osvScanTargets(info({ ecosystem: 'php', manifestPathsByEcosystem: byEco })).map((t) => t.eco),
    ).toEqual(['php', 'npm', 'python']);
    expect(
      osvScanTargets(info({ ecosystem: 'python', manifestPathsByEcosystem: byEco })).map((t) => t.eco),
    ).toEqual(['python', 'npm', 'php']);
  });
});
