// Unit tests for lib/pr/pr-scanner.ts (scanPRAndComment).
// PATTERN B: hoisted mock handles, vi.mock() before imports, import module last.
// Mocks the Octokit client (via @/lib/github's createGitHubClient), the CVE
// fetch (@/lib/cve/github-advisories), and @/lib/prisma. comment-formatter is
// left real (pure, already covered by tests/unit/pr-comment-formatter.test.ts)
// so we can assert on the actual comment body content.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  createGitHubClientMock,
  fetchRepoAdvisoriesMock,
  repoFindFirst,
  scanFindFirst,
  listCommentsMock,
  updateCommentMock,
  createCommentMock,
} = vi.hoisted(() => ({
  createGitHubClientMock: vi.fn(),
  fetchRepoAdvisoriesMock: vi.fn(),
  repoFindFirst: vi.fn(),
  scanFindFirst: vi.fn(),
  listCommentsMock: vi.fn(),
  updateCommentMock: vi.fn(),
  createCommentMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/github', () => ({ createGitHubClient: createGitHubClientMock }));
vi.mock('@/lib/cve/github-advisories', () => ({ fetchRepoAdvisories: fetchRepoAdvisoriesMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: { findFirst: repoFindFirst },
    scan: { findFirst: scanFindFirst },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { scanPRAndComment } from '@/lib/pr/pr-scanner';

function makeAdvisory(overrides: Partial<{ ghsaId: string; severity: string }> = {}) {
  const ghsaId = overrides.ghsaId ?? 'GHSA-aaaa-bbbb-cccc';
  return {
    ghsaId,
    cveId: 'CVE-2026-0001',
    severity: overrides.severity ?? 'HIGH',
    summary: 'A vulnerability',
    packageName: 'lodash',
    ecosystem: 'npm',
    vulnerableRange: '<4.17.21',
    fixedVersion: '4.17.21',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    url: `https://github.com/advisories/${ghsaId}`,
    source: 'dependabot' as const,
  };
}

function makeOctokit() {
  return {
    rest: {
      issues: {
        listComments: listCommentsMock,
        updateComment: updateCommentMock,
        createComment: createCommentMock,
      },
    },
  };
}

beforeEach(() => {
  createGitHubClientMock.mockReset();
  fetchRepoAdvisoriesMock.mockReset();
  repoFindFirst.mockReset();
  scanFindFirst.mockReset();
  listCommentsMock.mockReset();
  updateCommentMock.mockReset();
  createCommentMock.mockReset();

  createGitHubClientMock.mockReturnValue(makeOctokit());
  listCommentsMock.mockResolvedValue({ data: [] });
  repoFindFirst.mockResolvedValue(null);
});

describe('scanPRAndComment — success path', () => {
  it('constructs the Octokit client with the access token and posts a new comment when none exists', async () => {
    fetchRepoAdvisoriesMock.mockResolvedValue({
      advisories: [makeAdvisory()],
      counts: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0, total: 1 },
      riskScore: 40,
    });
    createCommentMock.mockResolvedValue({ data: { html_url: 'https://github.com/acme/api/pull/1#issuecomment-1' } });

    const result = await scanPRAndComment('tok-123', 'acme', 'api', 1, 'user-1');

    expect(createGitHubClientMock).toHaveBeenCalledWith('tok-123');
    expect(createCommentMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'api',
      issue_number: 1,
      body: expect.stringContaining('<!-- depsight-cve-scan -->'),
    });
    expect(createCommentMock.mock.calls[0][0].body).toContain('GHSA-aaaa-bbbb-cccc');
    expect(updateCommentMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      commented: true,
      newCVECount: 1,
      commentUrl: 'https://github.com/acme/api/pull/1#issuecomment-1',
    });
  });

  it('updates an existing depsight comment (marker match) instead of creating a new one', async () => {
    listCommentsMock.mockResolvedValue({
      data: [{ id: 999, body: 'unrelated comment' }, { id: 555, body: '<!-- depsight-cve-scan -->\nold report' }],
    });
    fetchRepoAdvisoriesMock.mockResolvedValue({
      advisories: [makeAdvisory()],
      counts: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0, total: 1 },
      riskScore: 40,
    });
    updateCommentMock.mockResolvedValue({ data: { html_url: 'https://github.com/acme/api/pull/1#issuecomment-555' } });

    const result = await scanPRAndComment('tok-123', 'acme', 'api', 1, 'user-1');

    expect(updateCommentMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'api',
      comment_id: 555,
      body: expect.stringContaining('<!-- depsight-cve-scan -->'),
    });
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(result.commentUrl).toBe('https://github.com/acme/api/pull/1#issuecomment-555');
  });

  it('filters out advisories already seen in the previous COMPLETED scan (newCVECount only counts new GHSA ids)', async () => {
    repoFindFirst.mockResolvedValue({ id: 'db-repo-1' });
    scanFindFirst.mockResolvedValue({
      advisories: [{ ghsaId: 'GHSA-aaaa-bbbb-cccc' }],
    });
    fetchRepoAdvisoriesMock.mockResolvedValue({
      advisories: [makeAdvisory({ ghsaId: 'GHSA-aaaa-bbbb-cccc' }), makeAdvisory({ ghsaId: 'GHSA-new-new-new' })],
      counts: { critical: 0, high: 2, medium: 0, low: 0, unknown: 0, total: 2 },
      riskScore: 40,
    });
    createCommentMock.mockResolvedValue({ data: { html_url: 'https://x/comment' } });

    const result = await scanPRAndComment('tok-123', 'acme', 'api', 1, 'user-1');

    expect(scanFindFirst).toHaveBeenCalledWith({
      where: { repoId: 'db-repo-1', status: 'COMPLETED' },
      orderBy: { scannedAt: 'desc' },
      include: { advisories: { select: { ghsaId: true } } },
    });
    expect(result.newCVECount).toBe(1);
    // Only the NEW advisory (GHSA-new-new-new) appears in the comment body;
    // the already-seen GHSA-aaaa-bbbb-cccc is filtered out.
    const body = createCommentMock.mock.calls[0][0].body as string;
    expect(body).toContain('GHSA-new-new-new');
    expect(body).not.toContain('GHSA-aaaa-bbbb-cccc');
  });
});

describe('scanPRAndComment — failure/edge branches', () => {
  it('when listComments fails, proceeds anyway and creates a new comment (existingCommentId stays null)', async () => {
    listCommentsMock.mockRejectedValue(new Error('403 forbidden'));
    fetchRepoAdvisoriesMock.mockResolvedValue({
      advisories: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: 0 },
      riskScore: 0,
    });
    createCommentMock.mockResolvedValue({ data: { html_url: 'https://x/comment' } });

    const result = await scanPRAndComment('tok-123', 'acme', 'api', 1, 'user-1');

    expect(createCommentMock).toHaveBeenCalled();
    expect(result.commented).toBe(true);
  });

  it('when posting the comment fails (createComment throws), the scan result is still returned with commented:false and a null commentUrl', async () => {
    fetchRepoAdvisoriesMock.mockResolvedValue({
      advisories: [makeAdvisory()],
      counts: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0, total: 1 },
      riskScore: 40,
    });
    createCommentMock.mockRejectedValue(new Error('422 unprocessable'));

    const result = await scanPRAndComment('tok-123', 'acme', 'api', 1, 'user-1');

    expect(result).toEqual({ commented: false, newCVECount: 1, commentUrl: null });
  });

  it('propagates a fetchRepoAdvisories rejection (e.g. GitHub API error) without posting any comment', async () => {
    fetchRepoAdvisoriesMock.mockRejectedValue(new Error('GitHub API error'));

    await expect(scanPRAndComment('tok-123', 'acme', 'api', 1, 'user-1')).rejects.toThrow('GitHub API error');
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(updateCommentMock).not.toHaveBeenCalled();
  });

  it('when the repo is not tracked in depsight (dbRepo null), skips the previous-scan lookup and treats all advisories as new', async () => {
    repoFindFirst.mockResolvedValue(null);
    fetchRepoAdvisoriesMock.mockResolvedValue({
      advisories: [makeAdvisory()],
      counts: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0, total: 1 },
      riskScore: 40,
    });
    createCommentMock.mockResolvedValue({ data: { html_url: 'https://x/comment' } });

    const result = await scanPRAndComment('tok-123', 'acme', 'api', 1, 'user-1');

    expect(scanFindFirst).not.toHaveBeenCalled();
    expect(result.newCVECount).toBe(1);
  });
});
