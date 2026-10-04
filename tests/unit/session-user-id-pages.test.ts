// The server-rendered pages that load per-user data must treat a session with
// a user but no user id (a valid JWT whose user row is gone) like no session:
// redirect to /login, and never query with an undefined userId, which Prisma
// would drop from the filter and so match every user's rows.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  redirectMock,
  repoFindMany,
  workflowFindMany,
  getTeamHealthOverviewMock,
  listPoliciesMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  repoFindMany: vi.fn(),
  workflowFindMany: vi.fn(),
  getTeamHealthOverviewMock: vi.fn(),
  listPoliciesMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: { findMany: repoFindMany },
    workflow: { findMany: workflowFindMany },
  },
}));
vi.mock('@/lib/overview/team-health', () => ({ getTeamHealthOverview: getTeamHealthOverviewMock }));
vi.mock('@/lib/policy/service', () => ({ listPolicies: listPoliciesMock }));
vi.mock('@/lib/scan/freshness', () => ({ getScannerStatuses: vi.fn() }));
vi.mock('@/app/overview/OverviewClient', () => ({ OverviewClient: () => null }));
vi.mock('@/app/dashboard/DashboardClient', () => ({ DashboardClient: () => null }));
vi.mock('@/app/policies/PoliciesClient', () => ({ PoliciesClient: () => null }));

import OverviewPage from '@/app/overview/page';
import DashboardPage from '@/app/dashboard/page';
import PoliciesPage from '@/app/policies/page';

const NO_ID_SESSION = { user: { githubToken: 'tok-123' } };

describe('server pages: session without a user id', () => {
  beforeEach(() => {
    authMock.mockReset();
    redirectMock.mockClear();
    repoFindMany.mockReset();
    workflowFindMany.mockReset();
    getTeamHealthOverviewMock.mockReset();
    listPoliciesMock.mockReset();
    authMock.mockResolvedValue(NO_ID_SESSION);
  });

  it('/overview redirects to /login and does not load the team overview', async () => {
    await expect(OverviewPage()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(getTeamHealthOverviewMock).not.toHaveBeenCalled();
  });

  it('/dashboard redirects to /login and does not query repos', async () => {
    await expect(
      DashboardPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(repoFindMany).not.toHaveBeenCalled();
    expect(workflowFindMany).not.toHaveBeenCalled();
  });

  it('/policies redirects to /login and does not list policies', async () => {
    await expect(PoliciesPage()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(listPoliciesMock).not.toHaveBeenCalled();
  });

  it('/dashboard still filters by the real user id when the session has one', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1', githubToken: 'tok-123' } });
    repoFindMany.mockResolvedValue([]);

    await DashboardPage({ searchParams: Promise.resolve({}) });

    expect(repoFindMany).toHaveBeenCalledTimes(1);
    expect(repoFindMany.mock.calls[0][0].where).toEqual({ userId: 'user-1', tracked: true });
  });
});
