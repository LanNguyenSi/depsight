/**
 * Downstream of the narrow override: `collectDeps` can now hand several entries
 * for one package name (one per installed version) to the OSV step and to the
 * advisory merge. These tests pin that nothing there keys by package name only:
 *
 *   - fetchOsvAdvisories queries each (name, version) pair, maps every OSV
 *     result back to the pair that produced it, and computes the vulnerable
 *     range and fixed version from THAT pair's version;
 *   - mergeCveAdvisories (the scanner's next step) collapses the same
 *     (advisory, package) reported for two versions into one row, by design
 *     (the Advisory table holds one row per scan, ghsaId and packageName).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

import { fetchOsvAdvisories } from '@/lib/cve/osv';
import { mergeCveAdvisories } from '@/lib/cve/merge';
import { loadRepo } from './helpers/npm-repo-fixture';
import { SCENARIOS } from './helpers/npm-scenarios';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// OSV: GHSA-low affects vite >= 7.0.0 < 7.3.8; GHSA-all affects 7.x below 7.4.0
// and 8.x below 8.4.0. vite@7.3.7 hits both, vite@8.3.5 only GHSA-all.
const VULNS: Record<string, unknown> = {
  'GHSA-low': {
    id: 'GHSA-low',
    summary: 'low range',
    affected: [{ package: { name: 'vite', ecosystem: 'npm' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '7.0.0' }, { fixed: '7.3.8' }] }] }],
  },
  'GHSA-all': {
    id: 'GHSA-all',
    summary: 'wide range',
    affected: [
      {
        package: { name: 'vite', ecosystem: 'npm' },
        ranges: [
          { type: 'ECOSYSTEM', events: [{ introduced: '7.0.0' }, { fixed: '7.4.0' }] },
          { type: 'ECOSYSTEM', events: [{ introduced: '8.0.0' }, { fixed: '8.4.0' }] },
        ],
      },
    ],
  },
};

function stubOsv(queriesSeen: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('querybatch')) {
        const { queries } = JSON.parse(init!.body!) as { queries: Array<{ package: { name: string }; version: string }> };
        for (const q of queries) queriesSeen.push(`${q.package.name}@${q.version}`);
        return {
          ok: true,
          json: async () => ({
            results: queries.map((q) => ({
              vulns:
                q.version === '7.3.7'
                  ? [{ id: 'GHSA-low' }, { id: 'GHSA-all' }]
                  : q.version === '8.3.5'
                    ? [{ id: 'GHSA-all' }]
                    : [],
            })),
          }),
        };
      }
      const id = decodeURIComponent(String(url).split('/vulns/')[1]);
      return { ok: true, json: async () => VULNS[id] };
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('several installed versions of one package through the OSV step and the merge', () => {
  it('maps each OSV result to the (name, version) pair that was queried', async () => {
    const seen: string[] = [];
    stubOsv(seen);
    loadRepo(SCENARIOS.viteTwoProjects);
    const { advisories } = await fetchOsvAdvisories('t', 'o', 'r', 'main');

    expect(seen.sort()).toEqual(['vite@7.3.7', 'vite@8.3.5']);
    // vite@7.3.7: GHSA-low and GHSA-all; vite@8.3.5: GHSA-all
    const key = (a: { ghsaId: string; vulnerableRange: string | null; fixedVersion: string | null }) =>
      `${a.ghsaId} ${a.vulnerableRange} -> ${a.fixedVersion}`;
    expect(advisories.map(key).sort()).toEqual([
      'GHSA-all >=7.0.0 <7.4.0 -> 7.4.0',
      'GHSA-all >=8.0.0 <8.4.0 -> 8.4.0',
      'GHSA-low >=7.0.0 <7.3.8 -> 7.3.8',
    ]);
    expect(advisories.every((a) => a.packageName === 'vite')).toBe(true);
  });

  it('the merge keeps one row per (advisory, package), the first reported', async () => {
    const seen: string[] = [];
    stubOsv(seen);
    loadRepo(SCENARIOS.viteTwoProjects);
    const { advisories } = await fetchOsvAdvisories('t', 'o', 'r', 'main');

    const merged = mergeCveAdvisories([], advisories);
    expect(merged.map((a) => a.ghsaId).sort()).toEqual(['GHSA-all', 'GHSA-low']);
    // Same advisory for 7.3.7 and 8.3.5: deliberately one row (Advisory unique key).
    expect(advisories.filter((a) => a.ghsaId === 'GHSA-all')).toHaveLength(2);
  });
});
