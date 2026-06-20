import { vi, describe, it, expect, beforeEach } from 'vitest';

// Must be hoisted before the module-under-test is imported
vi.mock('@/lib/github', () => ({
  createGitHubClient: vi.fn(),
}));

import { createGitHubClient } from '@/lib/github';
import { fetchRepoAdvisories } from '@/lib/cve/github-advisories';

// Minimal valid alert shape expected by fetchRepoAdvisories
function makeAlert(id: number) {
  return {
    security_advisory: {
      ghsa_id: `GHSA-0000-0000-${String(id).padStart(4, '0')}`,
      cve_id: null,
      severity: 'HIGH',
      summary: `Fake advisory ${id}`,
      published_at: '2024-01-01T00:00:00Z',
      url: `https://github.com/advisories/GHSA-0000-0000-${String(id).padStart(4, '0')}`,
    },
    security_vulnerability: {
      package: { name: `pkg-${id}`, ecosystem: 'npm' },
      vulnerable_version_range: '< 1.0.0',
      first_patched_version: { identifier: '1.0.0' },
    },
  };
}

function makeMockOctokit(paginateImpl: () => Promise<unknown>) {
  return {
    paginate: vi.fn().mockImplementation(paginateImpl),
    rest: {
      dependabot: {
        listAlertsForRepo: {},
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchRepoAdvisories', () => {
  it('returns all advisories when paginate resolves with more than 100 alerts (pagination cap removed)', async () => {
    // Generate 150 fake alerts to confirm the old per_page=100 hard-cap is gone
    const fakeAlerts = Array.from({ length: 150 }, (_, i) => makeAlert(i + 1));

    vi.mocked(createGitHubClient).mockReturnValue(
      makeMockOctokit(() => Promise.resolve(fakeAlerts)) as ReturnType<typeof createGitHubClient>,
    );

    const result = await fetchRepoAdvisories('token', 'owner', 'repo');

    expect(result.dependabotDisabled).toBeFalsy();
    expect(result.advisories).toHaveLength(150);
    expect(result.counts.total).toBe(150);
  });

  it('returns dependabotDisabled=true when paginate rejects with status 404', async () => {
    vi.mocked(createGitHubClient).mockReturnValue(
      makeMockOctokit(() => Promise.reject({ status: 404 })) as ReturnType<typeof createGitHubClient>,
    );

    const result = await fetchRepoAdvisories('token', 'owner', 'repo');

    expect(result.dependabotDisabled).toBe(true);
    expect(result.advisories).toHaveLength(0);
  });

  it('throws (does not swallow) when paginate rejects with 403 + x-ratelimit-remaining=0 (rate-limited)', async () => {
    const rateLimitError = {
      status: 403,
      message: 'API rate limit exceeded',
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    };

    vi.mocked(createGitHubClient).mockReturnValue(
      makeMockOctokit(() => Promise.reject(rateLimitError)) as ReturnType<typeof createGitHubClient>,
    );

    await expect(fetchRepoAdvisories('token', 'owner', 'repo')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('throws when paginate rejects with 403 + retry-after header (rate-limited)', async () => {
    const retryAfterError = {
      status: 403,
      message: 'You have exceeded a secondary rate limit',
      response: { headers: { 'retry-after': '60' } },
    };

    vi.mocked(createGitHubClient).mockReturnValue(
      makeMockOctokit(() => Promise.reject(retryAfterError)) as ReturnType<typeof createGitHubClient>,
    );

    await expect(fetchRepoAdvisories('token', 'owner', 'repo')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('returns dependabotDisabled=true when paginate rejects with 403 and "Dependabot alerts are disabled" message', async () => {
    const disabledError = {
      status: 403,
      message: 'Dependabot alerts are disabled for this repository',
    };

    vi.mocked(createGitHubClient).mockReturnValue(
      makeMockOctokit(() => Promise.reject(disabledError)) as ReturnType<typeof createGitHubClient>,
    );

    const result = await fetchRepoAdvisories('token', 'owner', 'repo');

    expect(result.dependabotDisabled).toBe(true);
    expect(result.advisories).toHaveLength(0);
  });

  it('re-throws non-403/404 errors as-is', async () => {
    const networkError = { status: 500, message: 'Internal Server Error' };

    vi.mocked(createGitHubClient).mockReturnValue(
      makeMockOctokit(() => Promise.reject(networkError)) as ReturnType<typeof createGitHubClient>,
    );

    await expect(fetchRepoAdvisories('token', 'owner', 'repo')).rejects.toMatchObject({
      status: 500,
    });
  });
});
