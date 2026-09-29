// Degraded-source marker (task 0f3559ba): drives the REAL scanners and the REAL
// source readers (Dependabot fetch, OSV fetch, manifest discovery, license
// lookup, dependency-age analysis) against an in-memory Repo row. Only the
// GitHub client, the global fetch (OSV, registries) and prisma are faked.
//
// A scanner whose source could not be read must not advance its last-success
// time and must show the failure marker; a source that was read and simply had
// nothing to find (404, no manifest, no license file) is still a success.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanRepository } from '@/lib/cve/scanner';
import { scanLicenses } from '@/lib/license/scanner';
import { scanDependencies } from '@/lib/deps/scanner';
import { failingScanners, getScannerStatuses } from '@/lib/scan/freshness';

const { store, gh } = vi.hoisted(() => {
  const store = {
    repo: {} as Record<string, unknown>,
    scans: [] as Array<Record<string, unknown>>,
    nextScanId: 1,
  };
  const gh = {
    getTree: vi.fn(),
    reposGet: vi.fn(),
    getContent: vi.fn(),
    getForRepo: vi.fn(),
    listAlerts: vi.fn(),
    paginate: vi.fn(),
  };
  return { store, gh };
});

vi.mock('@/lib/prisma', () => {
  const repoApi = {
    findUnique: vi.fn(async () => store.repo),
    findFirst: vi.fn(async () => store.repo),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(store.repo, data);
      return store.repo;
    }),
  };
  const scanApi = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const scan = { id: `scan-${store.nextScanId++}`, ...data };
      store.scans.push(scan);
      return scan;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const scan = store.scans.find((s) => s.id === where.id)!;
      Object.assign(scan, data);
      return scan;
    }),
  };
  const tx = {
    repo: repoApi,
    scan: scanApi,
    advisory: { createMany: vi.fn(async () => ({})) },
    licenseResult: { createMany: vi.fn(async () => ({})) },
    dependency: { createMany: vi.fn(async () => ({})) },
  };
  return {
    prisma: {
      repo: repoApi,
      scan: scanApi,
      advisory: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    },
  };
});

vi.mock('@/lib/github', () => ({
  createGitHubClient: () => ({
    paginate: gh.paginate,
    rest: {
      git: { getTree: gh.getTree },
      repos: { get: gh.reposGet, getContent: gh.getContent },
      licenses: { getForRepo: gh.getForRepo },
      dependabot: { listAlertsForRepo: gh.listAlerts },
    },
  }),
}));
vi.mock('@/lib/alerts/notifier', () => ({ notifyForScan: vi.fn(async () => undefined) }));
vi.mock('@/lib/alerts/post-scan', () => ({ runPostScanHooks: vi.fn(async () => undefined) }));

const T1 = new Date('2026-07-01T12:00:00.000Z');
const T2 = new Date('2026-07-01T14:00:00.000Z');

type Scanner = 'cve' | 'license' | 'deps';

const runners: Record<Scanner, () => Promise<unknown>> = {
  cve: () => scanRepository('user-1', 'repo-1', 'tok'),
  license: () => scanLicenses('user-1', 'repo-1', 'tok'),
  deps: () => scanDependencies('user-1', 'repo-1', 'tok'),
};
const SCANNERS: Scanner[] = ['cve', 'license', 'deps'];
const errorField = (s: Scanner) => `${s}ScanError`;
const stampField = (s: Scanner) => `${s}ScannedAt`;

function httpError(status: number, message: string, headers?: Record<string, string>) {
  return Object.assign(new Error(message), { status, response: headers ? { headers } : undefined });
}

function b64(text: string) {
  return { data: { content: Buffer.from(text).toString('base64') } };
}

interface GitHubFixture {
  /** Answer for the recursive git tree read. */
  tree?: { paths: string[] } | Error;
  /** Answer per repo-relative file path; a missing key answers 404. The '' key is the root listing. */
  files?: Record<string, string | string[] | Error>;
  licenseLookup?: Error | { spdx: string | null };
  dependabot?: Error | unknown[];
}

function setGitHub(fixture: GitHubFixture) {
  const { tree = { paths: [] }, files = {}, licenseLookup, dependabot = [] } = fixture;
  gh.reposGet.mockResolvedValue({ data: { default_branch: 'main' } });
  gh.getTree.mockImplementation(async () => {
    if (tree instanceof Error) throw tree;
    return { data: { tree: tree.paths.map((path) => ({ path, type: 'blob' })), truncated: false } };
  });
  gh.getContent.mockImplementation(async ({ path }: { path: string }) => {
    const entry = files[path];
    if (entry === undefined) throw httpError(404, 'Not Found');
    if (entry instanceof Error) throw entry;
    if (Array.isArray(entry)) return { data: entry.map((name) => ({ name, type: 'file' })) };
    return b64(entry);
  });
  gh.getForRepo.mockImplementation(async () => {
    if (licenseLookup instanceof Error) throw licenseLookup;
    if (licenseLookup === undefined) throw httpError(404, 'Not Found');
    return { data: { license: licenseLookup.spdx ? { spdx_id: licenseLookup.spdx } : null } };
  });
  gh.paginate.mockImplementation(async () => {
    if (dependabot instanceof Error) throw dependabot;
    return dependabot;
  });
}

/** Every call the GitHub client offers rejects with the same HTTP error. */
function setGitHubRejectingEverything(status: number, message: string) {
  const err = () => httpError(status, message);
  gh.reposGet.mockRejectedValue(err());
  gh.getTree.mockRejectedValue(err());
  gh.getContent.mockRejectedValue(err());
  gh.getForRepo.mockRejectedValue(err());
  gh.paginate.mockRejectedValue(err());
}

interface FetchFixture {
  querybatch?: Response | Error;
  vulnDetail?: Response | Error;
  registry?: Response | Error;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setFetch(fixture: FetchFixture = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const pick = (answer: Response | Error | undefined, fallback: Response) => {
      if (answer instanceof Error) throw answer;
      return answer ? answer.clone() : fallback;
    };
    if (url.includes('api.osv.dev/v1/querybatch')) return pick(fixture.querybatch, jsonResponse({ results: [] }));
    if (url.includes('api.osv.dev/v1/vulns/')) return pick(fixture.vulnDetail, jsonResponse({ id: 'x' }));
    if (url.includes('registry.npmjs.org')) return pick(fixture.registry, jsonResponse({ license: 'MIT', 'dist-tags': { latest: '1.0.0' } }));
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const NPM_MANIFEST_NO_DEPS = JSON.stringify({ name: 'app', version: '1.0.0' });
const NPM_MANIFEST_WITH_DEP = JSON.stringify({ name: 'app', dependencies: { lodash: '4.17.15' } });
const NPM_REPO: GitHubFixture = {
  tree: { paths: ['package.json'] },
  files: { 'package.json': NPM_MANIFEST_NO_DEPS },
};

function markerOf(scanner: Scanner): string | null {
  return getScannerStatuses(store.repo as never)[scanner].error;
}

/** Repo whose every scanner succeeded at T1; the run under test happens at T2. */
function seedHealthyAtT1() {
  store.repo = {
    ...store.repo,
    lastScannedAt: T1,
    cveScannedAt: T1,
    licenseScannedAt: T1,
    depsScannedAt: T1,
    cveScanError: null,
    licenseScanError: null,
    depsScanError: null,
  };
}

function expectDegraded(scanner: Scanner, pattern: RegExp | string) {
  expect(store.repo[stampField(scanner)]).toEqual(T1); // last success did not advance
  expect(store.repo.lastScannedAt).toEqual(T1);
  expect(markerOf(scanner)).toMatch(pattern);
  expect(failingScanners(getScannerStatuses(store.repo as never))).toContain(scanner);
}

function expectSuccess(scanner: Scanner) {
  expect(store.repo[stampField(scanner)]).toEqual(T2);
  expect(store.repo.lastScannedAt).toEqual(T2);
  expect(store.repo[errorField(scanner)]).toBeNull();
}

beforeEach(() => {
  store.repo = {
    id: 'repo-1',
    userId: 'user-1',
    tracked: true,
    owner: 'acme',
    name: 'repo-1',
    fullName: 'acme/repo-1',
    defaultBranch: 'main',
  };
  store.scans = [];
  store.nextScanId = 1;
  for (const fn of Object.values(gh)) fn.mockReset();
  setGitHub({});
  setFetch();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T2);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitHub client rejecting 401 on every call', () => {
  it.each(SCANNERS)('the %s scanner ends degraded and its last success does not advance', async (scanner) => {
    seedHealthyAtT1();
    setGitHubRejectingEverything(401, 'Bad credentials');

    await runners[scanner]();

    expectDegraded(scanner, /401/);
    expect(markerOf(scanner)).toContain('Bad credentials');
  });

  it('each scanner still completes its scan row: the degraded run stores what it found', async () => {
    seedHealthyAtT1();
    setGitHubRejectingEverything(401, 'Bad credentials');

    for (const scanner of SCANNERS) await runners[scanner]();

    expect(store.scans).toHaveLength(3);
    expect(store.scans.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED']);
  });

  it('a later run that can read the sources again clears the marker and advances the success time', async () => {
    seedHealthyAtT1();
    setGitHubRejectingEverything(401, 'Bad credentials');
    for (const scanner of SCANNERS) await runners[scanner]();
    for (const scanner of SCANNERS) expect(markerOf(scanner)).not.toBeNull();

    const T3 = new Date('2026-07-01T16:00:00.000Z');
    vi.setSystemTime(T3);
    setGitHub(NPM_REPO);
    for (const scanner of SCANNERS) await runners[scanner]();

    for (const scanner of SCANNERS) {
      expect(store.repo[errorField(scanner)]).toBeNull();
      expect(store.repo[stampField(scanner)]).toEqual(T3);
    }
  });
});

describe('a source that was read and had nothing to find is a success', () => {
  const emptyRepoFixtures: Array<[string, () => void]> = [
    [
      'no manifests, no license file (git tree empty, root listing empty)',
      () => setGitHub({ tree: { paths: [] }, files: { '': [] } }),
    ],
    [
      'the git tree and the root listing both answer 404',
      () => setGitHub({ tree: httpError(404, 'Not Found') }),
    ],
    [
      'a brand-new repository whose git tree answers 409 empty',
      () => setGitHub({ tree: httpError(409, 'Git Repository is empty.') }),
    ],
    [
      'a package.json without dependencies and no license file',
      () => setGitHub(NPM_REPO),
    ],
    [
      'Dependabot alerts are not enabled (404)',
      () => setGitHub({ ...NPM_REPO, dependabot: httpError(404, 'Not Found') }),
    ],
    [
      'Dependabot alerts are not enabled (403, no rate limit)',
      () => setGitHub({ ...NPM_REPO, dependabot: httpError(403, 'Dependabot alerts are disabled for this repository.') }),
    ],
    [
      'a malformed package.json (repository content, not an unreadable source)',
      () => setGitHub({ tree: { paths: ['package.json'] }, files: { 'package.json': '{ not json' } }),
    ],
  ];

  it.each(emptyRepoFixtures)('%s: all three scanners succeed', async (_name, arrange) => {
    seedHealthyAtT1();
    arrange();

    for (const scanner of SCANNERS) await runners[scanner]();

    for (const scanner of SCANNERS) expectSuccess(scanner);
    expect(failingScanners(getScannerStatuses(store.repo as never))).toEqual([]);
  });

  it('a per-package registry failure stays a per-row result, not a scanner failure', async () => {
    seedHealthyAtT1();
    setGitHub({
      tree: { paths: ['package.json'] },
      files: { 'package.json': NPM_MANIFEST_WITH_DEP },
    });
    setFetch({ registry: jsonResponse({}, 500) });

    await runners.license();
    await runners.deps();

    expectSuccess('license');
    expectSuccess('deps');
  });
});

describe('Dependabot source', () => {
  it('a 401 on the Dependabot read alone degrades the CVE scanner while OSV is readable', async () => {
    seedHealthyAtT1();
    setGitHub({ ...NPM_REPO, dependabot: httpError(401, 'Bad credentials') });

    await runners.cve();

    expectDegraded('cve', /Dependabot.*401/s);
  });

  it('a rate-limited Dependabot read (403 with a rate-limit header) degrades the CVE scanner', async () => {
    seedHealthyAtT1();
    setGitHub({
      ...NPM_REPO,
      dependabot: httpError(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }),
    });

    await runners.cve();

    expectDegraded('cve', /Dependabot.*403/s);
  });

  it('a Dependabot server error (500) degrades the CVE scanner', async () => {
    seedHealthyAtT1();
    setGitHub({ ...NPM_REPO, dependabot: httpError(500, 'Server Error') });

    await runners.cve();

    expectDegraded('cve', /Dependabot.*500/s);
  });
});

describe('OSV source', () => {
  const withDependency: GitHubFixture = {
    tree: { paths: ['package.json'] },
    files: { 'package.json': NPM_MANIFEST_WITH_DEP },
  };

  it('a healthy OSV read that finds nothing is a success and does reach the OSV endpoint', async () => {
    seedHealthyAtT1();
    setGitHub(withDependency);
    const fetchMock = setFetch({ querybatch: jsonResponse({ results: [{}] }) });

    await runners.cve();

    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('api.osv.dev/v1/querybatch'))).toBe(true);
    expectSuccess('cve');
  });

  it('an OSV querybatch answering 500 degrades the CVE scanner', async () => {
    seedHealthyAtT1();
    setGitHub(withDependency);
    const fetchMock = setFetch({ querybatch: jsonResponse({}, 500) });

    await runners.cve();

    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('api.osv.dev/v1/querybatch'))).toBe(true);
    expectDegraded('cve', /OSV.*500/s);
  });

  it('an OSV querybatch that cannot be reached (network error or timeout) degrades the CVE scanner', async () => {
    seedHealthyAtT1();
    setGitHub(withDependency);
    setFetch({ querybatch: new Error('fetch failed') });

    await runners.cve();

    expectDegraded('cve', /OSV.*fetch failed/s);
  });

  it('a vulnerability whose OSV detail cannot be read degrades the CVE scanner', async () => {
    seedHealthyAtT1();
    setGitHub(withDependency);
    setFetch({
      querybatch: jsonResponse({ results: [{ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }] }] }),
      vulnDetail: jsonResponse({}, 503),
    });

    await runners.cve();

    expectDegraded('cve', /OSV.*503/s);
  });

  it('a vulnerability whose OSV detail request fails outright (network error or timeout) degrades the CVE scanner', async () => {
    seedHealthyAtT1();
    setGitHub(withDependency);
    setFetch({
      querybatch: jsonResponse({ results: [{ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }] }] }),
      vulnDetail: new Error('The operation was aborted'),
    });

    await runners.cve();

    expectDegraded('cve', /OSV vulnerability detail.*aborted/s);
  });
});

describe('manifest discovery source', () => {
  it.each(SCANNERS)('a manifest file that cannot be read (500) degrades the %s scanner', async (scanner) => {
    seedHealthyAtT1();
    setGitHub({
      tree: { paths: ['package.json'] },
      files: { 'package.json': httpError(500, 'Server Error') },
    });

    await runners[scanner]();

    expectDegraded(scanner, /500/);
  });

  it.each(SCANNERS)('a git tree that cannot be read (500) while the root probe works degrades the %s scanner', async (scanner) => {
    seedHealthyAtT1();
    setGitHub({
      tree: httpError(500, 'Server Error'),
      files: { '': ['package.json'], 'package.json': NPM_MANIFEST_NO_DEPS },
    });

    await runners[scanner]();

    expectDegraded(scanner, /tree.*500/is);
  });

  it.each(SCANNERS)('a root listing that cannot be read (403) after a missing git tree degrades the %s scanner', async (scanner) => {
    seedHealthyAtT1();
    setGitHub({
      tree: httpError(404, 'Not Found'),
      files: { '': httpError(403, 'Forbidden') },
    });

    await runners[scanner]();

    expectDegraded(scanner, /403/);
  });
});

describe('license lookup source', () => {
  it.each([
    [401, 'Bad credentials'],
    [500, 'Server Error'],
  ])('a repository license lookup answering %i degrades the license scanner', async (status, message) => {
    seedHealthyAtT1();
    setGitHub({ ...NPM_REPO, licenseLookup: httpError(status, message) });

    await runners.license();

    expectDegraded('license', new RegExp(`license.*${status}`, 'is'));
  });

  it('a repository without a license file (404) is not a failure', async () => {
    seedHealthyAtT1();
    setGitHub({ ...NPM_REPO });

    await runners.license();

    expectSuccess('license');
  });

  it('a repository whose license is reported but not detected is not a failure', async () => {
    seedHealthyAtT1();
    setGitHub({ ...NPM_REPO, licenseLookup: { spdx: null } });

    await runners.license();

    expectSuccess('license');
  });
});
