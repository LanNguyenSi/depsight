// Degraded-source marker (task 0f3559ba): the defensive handlers around the
// lockfile resolvers, the OSV dependency collection, the OSV outer handler and
// the license scan's outer 403 handler. The fake GitHub client cannot make the
// readers inside them throw (they catch their own errors), so these tests make
// the guarded helper itself reject and assert that the run is still reported
// as degraded instead of reading as "nothing found".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchOsvAdvisories } from '@/lib/cve/osv';
import { detectLicenses } from '@/lib/license/detector';
import { trackDegraded } from '@/lib/scan/degraded';
import { detectEcosystem, fetchNpmLockfileResolutions, fetchNpmManifests, fetchYarnLockfileResolutions } from '@/lib/manifest-discovery';
import { collectPythonDeps, fetchPythonLockfileResolutions } from '@/lib/manifests/python';

vi.mock('@/lib/github', () => ({
  createGitHubClient: () => ({
    rest: { licenses: { getForRepo: vi.fn(async () => ({ data: { license: null } })) } },
  }),
}));

vi.mock('@/lib/manifest-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifest-discovery')>();
  return {
    ...actual,
    detectEcosystem: vi.fn(),
    fetchNpmManifests: vi.fn(),
    fetchNpmLockfileResolutions: vi.fn(),
    fetchYarnLockfileResolutions: vi.fn(),
  };
});

vi.mock('@/lib/manifests/python', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifests/python')>();
  return {
    ...actual,
    collectPythonDeps: vi.fn(),
    fetchPythonLockfileResolutions: vi.fn(),
  };
});

const emptyResolutions = () => ({ resolved: new Map<string, string>(), ambiguous: new Map<string, string>() });
const boom = new Error('boom');

function ecosystem(name: 'npm' | 'python') {
  vi.mocked(detectEcosystem).mockResolvedValue({
    ecosystem: name,
    supported: true,
    manifestPaths: [name === 'npm' ? 'package.json' : 'requirements.txt'],
    observedLockfilePaths: null,
  } as never);
}

function osvScan() {
  return trackDegraded(() => fetchOsvAdvisories('tok', 'acme', 'repo', 'main'));
}

beforeEach(() => {
  vi.mocked(fetchNpmManifests).mockResolvedValue([]);
  vi.mocked(fetchNpmLockfileResolutions).mockResolvedValue(emptyResolutions() as never);
  vi.mocked(fetchYarnLockfileResolutions).mockResolvedValue(emptyResolutions() as never);
  vi.mocked(collectPythonDeps).mockResolvedValue([]);
  vi.mocked(fetchPythonLockfileResolutions).mockResolvedValue(new Map());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('OSV source: defensive handlers', () => {
  it('controls: with every helper answering, the run is not degraded', async () => {
    ecosystem('npm');
    expect((await osvScan()).degraded).toBeNull();
    ecosystem('python');
    expect((await osvScan()).degraded).toBeNull();
  });

  it('an npm lockfile resolution that rejects degrades the run and only that source', async () => {
    ecosystem('npm');
    vi.mocked(fetchNpmLockfileResolutions).mockRejectedValue(boom);
    const { degraded } = await osvScan();
    expect(degraded).toContain('npm lockfile resolution: boom');
    expect(degraded).not.toContain('yarn lockfile');
  });

  it('a yarn lockfile resolution that rejects degrades the run and only that source', async () => {
    ecosystem('npm');
    vi.mocked(fetchYarnLockfileResolutions).mockRejectedValue(boom);
    const { degraded } = await osvScan();
    expect(degraded).toContain('yarn lockfile resolution: boom');
    expect(degraded).not.toContain('npm lockfile');
  });

  it('a python lockfile resolution that rejects degrades the run', async () => {
    ecosystem('python');
    vi.mocked(fetchPythonLockfileResolutions).mockRejectedValue(boom);
    expect((await osvScan()).degraded).toContain('python lockfile resolution: boom');
  });

  it('a dependency collection that rejects degrades the run and returns no advisories', async () => {
    ecosystem('npm');
    vi.mocked(fetchNpmManifests).mockRejectedValue(boom);
    const { value, degraded } = await osvScan();
    expect(value.advisories).toEqual([]);
    expect(degraded).toContain('OSV dependency collection: boom');
  });

  it('an unexpected failure before any dependency is collected degrades the run', async () => {
    vi.mocked(detectEcosystem).mockRejectedValue(boom);
    const { value, degraded } = await osvScan();
    expect(value).toEqual({ advisories: [], ecosystem: null });
    expect(degraded).toContain('OSV scan: boom');
  });
});

describe('license scan: outer 403 handler', () => {
  it('a 403 that escapes the manifest read degrades the run and yields an empty result', async () => {
    ecosystem('npm');
    vi.mocked(fetchNpmManifests).mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const { value, degraded } = await trackDegraded(() => detectLicenses('tok', 'acme', 'repo', 'main'));
    expect(value.licenses).toEqual([]);
    expect(degraded).toContain('GitHub license scan: HTTP 403: forbidden');
  });

  it('a 404 that escapes the manifest read is nothing found, not degraded', async () => {
    ecosystem('npm');
    vi.mocked(fetchNpmManifests).mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    const { value, degraded } = await trackDegraded(() => detectLicenses('tok', 'acme', 'repo', 'main'));
    expect(value.licenses).toEqual([]);
    expect(degraded).toBeNull();
  });
});
