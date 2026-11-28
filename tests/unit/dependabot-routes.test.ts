// Route-level tests for the per-user rate limits on the Dependabot bulk
// routes: GET /api/dependabot/check (one GitHub request per tracked repo) and
// POST /api/dependabot/enable-all (one GitHub write per given tracked repo).
// Both answer 429 with the repo's rate-limit shape once the user is over its
// hourly budget, with no database and no GitHub work; the routes have separate
// budgets, two users have separate budgets, and a 401 does not consume a slot.
// The body read of enable-all is spied through (real implementation) to pin
// that the limit is checked before the body is read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  authMock,
  repoFindMany,
  getSessionGitHubTokenMock,
  createGitHubClientMock,
  octokitRequestMock,
  enableDependabotAlertsMock,
  readJsonCappedSpy,
  actualReadJsonCappedRef,
} = vi.hoisted(() => {
  const ref: { fn?: (req: Request, maxBytes?: number) => Promise<unknown> } = {};
  return {
    authMock: vi.fn(),
    repoFindMany: vi.fn(),
    getSessionGitHubTokenMock: vi.fn(),
    createGitHubClientMock: vi.fn(),
    octokitRequestMock: vi.fn(),
    enableDependabotAlertsMock: vi.fn(),
    readJsonCappedSpy: vi.fn((req: Request, maxBytes?: number) =>
      (actualReadJsonCappedRef.fn as NonNullable<typeof ref.fn>)(req, maxBytes),
    ),
    actualReadJsonCappedRef: ref,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({ prisma: { repo: { findMany: repoFindMany } } }));
vi.mock('@/lib/auth-api', () => ({ getSessionGitHubToken: getSessionGitHubTokenMock }));
vi.mock('@/lib/github', () => ({ createGitHubClient: createGitHubClientMock }));
vi.mock('@/lib/cve/github-advisories', () => ({
  enableDependabotAlerts: enableDependabotAlertsMock,
}));
vi.mock('@/lib/http/read-json-capped', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/http/read-json-capped')>();
  actualReadJsonCappedRef.fn = actual.readJsonCapped;
  return { ...actual, readJsonCapped: readJsonCappedSpy };
});

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/dependabot/check/route';
import { POST } from '@/app/api/dependabot/enable-all/route';
import { NextRequest } from 'next/server';
import {
  dependabotCheckRateLimiter,
  dependabotEnableAllRateLimiter,
  DEPENDABOT_CHECK_LIMIT_PER_HOUR,
  DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR,
} from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const WINDOW_SECONDS = 60 * 60;
const SESSION_A = { user: { id: 'user-a' } };
const SESSION_B = { user: { id: 'user-b' } };
const REPOS = [
  { id: 'r1', owner: 'acme', name: 'api', fullName: 'acme/api' },
  { id: 'r2', owner: 'acme', name: 'web', fullName: 'acme/web' },
];

function makeEnableAllRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/dependabot/enable-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function resetMocks(): void {
  authMock.mockReset();
  repoFindMany.mockReset();
  repoFindMany.mockResolvedValue(REPOS);
  getSessionGitHubTokenMock.mockReset();
  getSessionGitHubTokenMock.mockResolvedValue('gh_tok');
  createGitHubClientMock.mockReset();
  createGitHubClientMock.mockReturnValue({ request: octokitRequestMock });
  octokitRequestMock.mockReset();
  octokitRequestMock.mockResolvedValue(undefined);
  enableDependabotAlertsMock.mockReset();
  enableDependabotAlertsMock.mockResolvedValue(true);
  readJsonCappedSpy.mockClear();
}

// ---------------------------------------------------------------------------
// GET /api/dependabot/check
// ---------------------------------------------------------------------------
describe('GET /api/dependabot/check: per-user rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    dependabotCheckRateLimiter.reset();
    dependabotEnableAllRateLimiter.reset();
    resetMocks();
    authMock.mockResolvedValue(SESSION_A);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the two budgets at 12 per hour each', () => {
    expect(DEPENDABOT_CHECK_LIMIT_PER_HOUR).toBe(12);
    expect(DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR).toBe(12);
  });

  it('answers unchanged below the limit, one GitHub request per tracked repo', async () => {
    for (let i = 0; i < DEPENDABOT_CHECK_LIMIT_PER_HOUR; i++) {
      const res = await GET();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ total: 2, disabledCount: 0, disabled: [] });
    }
    expect(octokitRequestMock).toHaveBeenCalledTimes(
      DEPENDABOT_CHECK_LIMIT_PER_HOUR * REPOS.length,
    );
  });

  it('answers 429 with Retry-After on the call over the budget, without a database or GitHub call', async () => {
    for (let i = 0; i < DEPENDABOT_CHECK_LIMIT_PER_HOUR; i++) {
      expect((await GET()).status).toBe(200);
    }
    const githubCalls = octokitRequestMock.mock.calls.length;
    const dbCalls = repoFindMany.mock.calls.length;

    const res = await GET();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_SECONDS));
    const body = (await res.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe('Rate limit exceeded');
    expect(body.retryAfterSeconds).toBe(WINDOW_SECONDS);
    expect(octokitRequestMock).toHaveBeenCalledTimes(githubCalls);
    expect(repoFindMany).toHaveBeenCalledTimes(dbCalls);
  });

  it('gives each user a separate budget', async () => {
    for (let i = 0; i < DEPENDABOT_CHECK_LIMIT_PER_HOUR; i++) {
      expect((await GET()).status).toBe(200);
    }
    expect((await GET()).status).toBe(429);

    authMock.mockResolvedValue(SESSION_B);
    expect((await GET()).status).toBe(200);
    const githubCalls = octokitRequestMock.mock.calls.length;
    expect(githubCalls).toBe(DEPENDABOT_CHECK_LIMIT_PER_HOUR * REPOS.length + REPOS.length);
  });

  it('does not consume a slot on a 401', async () => {
    authMock.mockResolvedValue(null);
    for (let i = 0; i < DEPENDABOT_CHECK_LIMIT_PER_HOUR + 3; i++) {
      expect((await GET()).status).toBe(401);
    }
    expect(repoFindMany).not.toHaveBeenCalled();
    expect(octokitRequestMock).not.toHaveBeenCalled();

    authMock.mockResolvedValue(SESSION_A);
    for (let i = 0; i < DEPENDABOT_CHECK_LIMIT_PER_HOUR; i++) {
      expect((await GET()).status).toBe(200);
    }
    expect((await GET()).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// POST /api/dependabot/enable-all
// ---------------------------------------------------------------------------
describe('POST /api/dependabot/enable-all: per-user rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    dependabotCheckRateLimiter.reset();
    dependabotEnableAllRateLimiter.reset();
    resetMocks();
    authMock.mockResolvedValue(SESSION_A);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers unchanged below the limit, one GitHub write per matching repo', async () => {
    for (let i = 0; i < DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR; i++) {
      const res = await POST(makeEnableAllRequest({ repoIds: ['r1', 'r2'] }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: 2, failed: 0 });
    }
    expect(enableDependabotAlertsMock).toHaveBeenCalledTimes(
      DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR * REPOS.length,
    );
  });

  it('answers 429 with Retry-After on the call over the budget, before reading the body and without a database or GitHub call', async () => {
    for (let i = 0; i < DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR; i++) {
      expect((await POST(makeEnableAllRequest({ repoIds: ['r1', 'r2'] }))).status).toBe(200);
    }
    const githubCalls = enableDependabotAlertsMock.mock.calls.length;
    const dbCalls = repoFindMany.mock.calls.length;
    readJsonCappedSpy.mockClear();

    const res = await POST(makeEnableAllRequest({ repoIds: ['r1', 'r2'] }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_SECONDS));
    const body = (await res.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe('Rate limit exceeded');
    expect(body.retryAfterSeconds).toBe(WINDOW_SECONDS);
    expect(enableDependabotAlertsMock).toHaveBeenCalledTimes(githubCalls);
    expect(repoFindMany).toHaveBeenCalledTimes(dbCalls);
    expect(readJsonCappedSpy).not.toHaveBeenCalled();
  });

  it('gives each user a separate budget', async () => {
    for (let i = 0; i < DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR; i++) {
      expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(200);
    }
    expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(429);

    authMock.mockResolvedValue(SESSION_B);
    expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(200);
  });

  it('does not consume a slot on a 401', async () => {
    authMock.mockResolvedValue(null);
    for (let i = 0; i < DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(401);
    }
    expect(repoFindMany).not.toHaveBeenCalled();
    expect(enableDependabotAlertsMock).not.toHaveBeenCalled();

    authMock.mockResolvedValue(SESSION_A);
    for (let i = 0; i < DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR; i++) {
      expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(200);
    }
    expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Budget separation between the two routes
// ---------------------------------------------------------------------------
describe('Dependabot routes do not share a budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    dependabotCheckRateLimiter.reset();
    dependabotEnableAllRateLimiter.reset();
    resetMocks();
    authMock.mockResolvedValue(SESSION_A);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spending the check budget leaves enable-all untouched and vice versa', async () => {
    for (let i = 0; i < DEPENDABOT_CHECK_LIMIT_PER_HOUR; i++) {
      expect((await GET()).status).toBe(200);
    }
    expect((await GET()).status).toBe(429);
    expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(200);

    for (let i = 0; i < DEPENDABOT_ENABLE_ALL_LIMIT_PER_HOUR - 1; i++) {
      expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(200);
    }
    expect((await POST(makeEnableAllRequest({ repoIds: ['r1'] }))).status).toBe(429);

    // The check route stayed at its own exhausted state, enable-all's spend
    // did not push the check budget further or free it.
    expect((await GET()).status).toBe(429);
  });
});
