/**
 * End-to-end scenarios for the narrow npm lockfile override in npm workspace
 * repositories (task b031d380). Every scenario runs the REAL pipeline
 * (detectEcosystem -> collectDeps -> OSV querybatch) on a synthetic repository
 * (tests/unit/helpers/npm-workspace-scenarios.ts); only the GitHub client and
 * `fetch` are mocked. Each test asserts the EXACT set of OSV queries.
 *
 * `base` is the query set of the code before workspaces could be narrow,
 * measured by running this scenario table against an export of the run base
 * (830f5a0), not assumed. `dropped` lists what head removes from it (with the
 * reason in `why`), `added` what it adds. A scenario that is not the proven
 * workspace shape must equal base.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/github', async () => (await import('./helpers/npm-repo-fixture')).githubMockModule());

import { fetchOsvAdvisories } from '@/lib/cve/osv';
import { runScan } from './helpers/npm-repo-fixture';
import { WORKSPACE_SCENARIOS } from './helpers/npm-workspace-scenarios';

interface Expectation {
  base: string[];
  dropped: string[];
  added: string[];
  why?: string;
}
const same = (base: string[]): Expectation => ({ base, dropped: [], added: [] });

const GOAL_BASE = ['vite@6.4.0', 'vite@7.0.0', 'vite@7.3.7', 'vitest@3.2.4'];
const goal = (why: string, base = GOAL_BASE): Expectation => ({ base, dropped: ['vite@7.0.0'], added: [], why });

const EXPECTED: Record<string, Expectation> = {
  // ---- the proven workspace shape: the floor no lockfile installs is dropped ----
  wsGoal: goal('root, a and b all resolve the root lockfile top-level vite 7.3.7; 7.0.0 is installed at no path'),
  wsLockfileVersion2: goal('as wsGoal, lockfileVersion 2'),
  wsObjectFormWorkspaces: goal('as wsGoal, `workspaces: { packages: [...] }` recorded unchanged'),
  wsNestedRootBesideStandalone: goal('the ws/ workspace proves its members; app/ is a standalone project with its own lockfile', [
    'vite@6.4.0',
    'vite@7.0.0',
    'vite@7.3.7',
    'vite@8.3.5',
    'vitest@3.2.4',
  ]),

  // ---- what the root lockfile cannot prove keeps the base result ----
  wsRootLockV1: same(['vite@7.3.7', 'vitest@3.2.4']),
  wsNoRootLock: same(['vite@7.0.0', 'vite@7.3.5', 'vitest@3.2.0']),
  wsRootLockReadError: same(['vite@7.0.0', 'vite@7.3.5', 'vitest@3.2.0']),
  wsWorkspacesNotRecorded: same(GOAL_BASE),
  wsWorkspacesRecordedStale: same(GOAL_BASE),
  wsMemberNotInLock: same(GOAL_BASE),
  wsMemberLinkMissing: same(GOAL_BASE),
  wsMemberManifestReadError: same(['b@1.0.0', 'vite@6.4.0', 'vite@7.3.5', 'vite@7.3.7', 'vitest@3.2.4']),
  wsLinkOutsideRepo: same(GOAL_BASE),
  wsNestedWorkspaceRoots: same(GOAL_BASE),
  wsMemberAlias: same(GOAL_BASE),
  wsMemberNestedCopy: same(['vite@6.4.0', 'vite@7.0.0', 'vite@7.3.6', 'vite@7.3.7', 'vitest@3.2.4']),
  wsMemberPeer: same(['vite@6.4.0', 'vite@7.3.5', 'vite@7.3.7', 'vitest@3.2.4']),
  wsMemberOptional: same(['vite@6.4.0', 'vite@7.3.5', 'vite@7.3.7', 'vitest@3.2.4']),
  wsMemberRangeNotSatisfied: same(['vite@6.4.0', 'vite@7.3.5', 'vite@7.3.7', 'vite@8.0.0', 'vitest@3.2.4']),
  wsMemberLinkVersionMismatch: same(GOAL_BASE),
  wsMemberOverrides: same(GOAL_BASE),
  wsNpmrc: same(GOAL_BASE),
};

describe('narrow npm lockfile override in workspaces: end-to-end OSV query scenarios', () => {
  it('has an expectation for every scenario and no stale ones', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(WORKSPACE_SCENARIOS).sort());
  });

  for (const [name, scenario] of Object.entries(WORKSPACE_SCENARIOS)) {
    it(name, async () => {
      const expected = EXPECTED[name];
      const { queries, degraded } = await runScan(fetchOsvAdvisories, scenario);
      const head = [...expected.base.filter((q) => !expected.dropped.includes(q)), ...expected.added].sort();
      expect(queries).toEqual(head);
      // No base entry is lost unless it is a documented drop, and every drop has a reason.
      expect(expected.base.filter((q) => !queries.includes(q)).sort()).toEqual([...expected.dropped].sort());
      if (expected.dropped.length > 0) expect(expected.why).toBeTruthy();
      expect(degraded !== null).toBe((scenario.fail ?? []).length > 0);
    });
  }
});
