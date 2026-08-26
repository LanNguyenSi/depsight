// Unit tests for lib/github.ts (the Octokit wrapper).
// Everywhere else in the codebase createGitHubClient() itself is mocked away
// (see tests/unit/github-advisories.test.ts) — this file tests lib/github.ts
// directly, mocking the underlying @octokit/rest Octokit constructor.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { OctokitMock, paginateMock, getContentMock } = vi.hoisted(() => ({
  OctokitMock: vi.fn(),
  paginateMock: vi.fn(),
  getContentMock: vi.fn(),
}));

// A stable marker object standing in for the real `octokit.rest.repos.listForAuthenticatedUser`
// endpoint reference, so we can assert paginate() was called with that exact reference.
const LIST_FOR_AUTHENTICATED_USER = { __marker: 'listForAuthenticatedUser' };

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@octokit/rest', () => ({ Octokit: OctokitMock }));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { createGitHubClient, getUserRepos, getRepoDependencyFiles } from '@/lib/github';

beforeEach(() => {
  OctokitMock.mockReset();
  paginateMock.mockReset();
  getContentMock.mockReset();

  // `new Octokit(opts)` — must be a `function`, not an arrow function, so it
  // is usable as a constructor. Returning an object from a constructor call
  // overrides the `this` binding per JS `new` semantics.
  OctokitMock.mockImplementation(function (opts: { auth: string }) {
    return {
      __opts: opts,
      paginate: paginateMock,
      rest: {
        repos: {
          listForAuthenticatedUser: LIST_FOR_AUTHENTICATED_USER,
          getContent: getContentMock,
        },
      },
    };
  });
});

describe('createGitHubClient', () => {
  it('constructs Octokit with the given access token as auth', () => {
    createGitHubClient('tok-abc');

    expect(OctokitMock).toHaveBeenCalledWith({ auth: 'tok-abc' });
  });

  it('returns the Octokit instance it constructs', () => {
    const client = createGitHubClient('tok-xyz');

    expect(client).toBeDefined();
    expect(OctokitMock).toHaveBeenCalledTimes(1);
  });
});

describe('getUserRepos', () => {
  it('paginates listForAuthenticatedUser with the exact options and maps the raw repo shape, including archived', async () => {
    paginateMock.mockResolvedValue([
      {
        id: 1,
        name: 'widgets',
        full_name: 'acme/widgets',
        description: 'A widget repo',
        private: false,
        html_url: 'https://github.com/acme/widgets',
        default_branch: 'main',
        updated_at: '2026-01-01T00:00:00Z',
        language: 'TypeScript',
        archived: false,
        owner: { login: 'acme', avatar_url: 'https://avatars/acme.png' },
      },
      {
        id: 2,
        name: 'boardflow',
        full_name: 'acme/boardflow',
        description: 'An archived repo',
        private: false,
        html_url: 'https://github.com/acme/boardflow',
        default_branch: 'main',
        updated_at: '2026-01-01T00:00:00Z',
        language: 'TypeScript',
        archived: true,
        owner: { login: 'acme', avatar_url: 'https://avatars/acme.png' },
      },
    ]);

    const repos = await getUserRepos('tok-abc');

    expect(OctokitMock).toHaveBeenCalledWith({ auth: 'tok-abc' });
    expect(paginateMock).toHaveBeenCalledWith(LIST_FOR_AUTHENTICATED_USER, {
      visibility: 'all',
      affiliation: 'owner,organization_member',
      sort: 'updated',
      per_page: 100,
    });
    expect(repos).toStrictEqual([
      {
        id: 1,
        name: 'widgets',
        fullName: 'acme/widgets',
        description: 'A widget repo',
        private: false,
        url: 'https://github.com/acme/widgets',
        defaultBranch: 'main',
        updatedAt: '2026-01-01T00:00:00Z',
        language: 'TypeScript',
        archived: false,
        owner: { login: 'acme', avatarUrl: 'https://avatars/acme.png' },
      },
      {
        id: 2,
        name: 'boardflow',
        fullName: 'acme/boardflow',
        description: 'An archived repo',
        private: false,
        url: 'https://github.com/acme/boardflow',
        defaultBranch: 'main',
        updatedAt: '2026-01-01T00:00:00Z',
        language: 'TypeScript',
        archived: true,
        owner: { login: 'acme', avatarUrl: 'https://avatars/acme.png' },
      },
    ]);
  });

  it('surfaces (does not swallow) a paginate rejection', async () => {
    paginateMock.mockRejectedValue(new Error('GitHub API rate limit exceeded'));

    await expect(getUserRepos('tok-abc')).rejects.toThrow('GitHub API rate limit exceeded');
  });
});

describe('getRepoDependencyFiles', () => {
  it('decodes base64 content for a found manifest file and passes owner/repo/path through', async () => {
    getContentMock.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'package.json') {
        return { data: { content: Buffer.from('{"name":"widgets"}').toString('base64') } };
      }
      throw { status: 404 };
    });

    const files = await getRepoDependencyFiles('tok-abc', 'acme', 'widgets');

    expect(getContentMock).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', path: 'package.json' });
    expect(files).toEqual([{ path: 'package.json', content: '{"name":"widgets"}' }]);
  });

  it('a 404 on one file does not abort the scan of the remaining candidate files (all 10 are attempted)', async () => {
    getContentMock.mockRejectedValue({ status: 404 });

    const files = await getRepoDependencyFiles('tok-abc', 'acme', 'widgets');

    expect(files).toEqual([]);
    expect(getContentMock).toHaveBeenCalledTimes(10);
  });

  it('skips a response whose data has no `content` field (e.g. a directory listing array)', async () => {
    getContentMock.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'package.json') return { data: [{ name: 'src', type: 'dir' }] };
      throw { status: 404 };
    });

    const files = await getRepoDependencyFiles('tok-abc', 'acme', 'widgets');

    expect(files).toEqual([]);
  });
});
