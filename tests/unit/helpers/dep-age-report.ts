/**
 * End-to-end helper for the npm dependency-age report tests: runs
 * `analyzeDepAge` on a synthetic repository (mocked GitHub client from
 * `npm-repo-fixture`) with a stubbed npm registry. A test file registers the
 * GitHub mock itself (vi.mock is hoisted per file):
 *
 *   vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());
 *
 * Only the GitHub client and the registry `fetch` are mocked, so discovery,
 * lockfile parsing and the narrow proof run for real.
 */
import { vi } from 'vitest';
import { analyzeDepAge } from '@/lib/deps/age-checker';
import { trackDegraded } from '@/lib/scan/degraded';
import { loadRepo, type Scenario } from './npm-repo-fixture';

/** One registry packument, reduced to the fields the report reads. */
export interface Packument {
  /** `dist-tags.latest`; omitted: the packument has no `dist-tags`. */
  latest?: string;
  /** publish times by version (also holds the `created` / `modified` keys when given). */
  time?: Record<string, string>;
  /** the `versions` keys; omitted: the packument has no `versions` map. */
  versions?: string[];
  /** `versions[<v>].deprecated` messages for the listed versions (needs `versions`). */
  deprecatedVersions?: Record<string, string>;
  /** the top-level `deprecated` field (full packuments have none). */
  deprecated?: string;
}
export type Registry = Record<string, Packument | 'down'>;

/** "Now" of the report: ageInDays counts from here. */
export const NOW = new Date('2026-10-26T00:00:00Z');

/** Run the report on a scenario against a registry; rows sorted by name. */
export async function report(scenario: Scenario, registry: Registry) {
  loadRepo(scenario);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const name = decodeURIComponent(String(url).replace('https://registry.npmjs.org/', ''));
      const entry = registry[name];
      if (entry === undefined || entry === 'down') return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          ...(entry.latest !== undefined ? { 'dist-tags': { latest: entry.latest } } : {}),
          ...(entry.time ? { time: entry.time } : {}),
          ...(entry.versions
            ? {
                versions: Object.fromEntries(
                  entry.versions.map((v) => [
                    v,
                    entry.deprecatedVersions?.[v] !== undefined
                      ? { deprecated: entry.deprecatedVersions[v] }
                      : {},
                  ]),
                ),
              }
            : {}),
          ...(entry.deprecated ? { deprecated: entry.deprecated } : {}),
        }),
      };
    }),
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { value: result, degraded } = await trackDegraded(() => analyzeDepAge('t', 'o', 'r', 'main'));
    const rows = [...result.dependencies].sort((a, b) => a.name.localeCompare(b.name));
    return { rows, summary: result.summary, degraded };
  } finally {
    warn.mockRestore();
    vi.unstubAllGlobals();
  }
}

/** `{ name: installedVersion }` of a report, the shape most tests compare. */
export const installed = (rows: Awaited<ReturnType<typeof report>>['rows']) =>
  Object.fromEntries(rows.map((r) => [r.name, r.installedVersion]));

/** A registry entry that knows exactly the listed versions, `latest` being the last. */
export const knows = (...versions: string[]): Packument => ({
  latest: versions[versions.length - 1],
  time: Object.fromEntries(versions.map((v) => [v, '2026-01-01T00:00:00Z'])),
});
