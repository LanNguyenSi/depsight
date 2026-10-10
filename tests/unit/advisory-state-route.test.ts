// Route-level tests for PUT and DELETE /api/advisory-state.
// Covers auth (401), write scope (403), body validation (400), the ownership
// guard (another user's repository answers 404 and nothing is written), the
// known-advisory guard, the upsert shape and the idempotent clear.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  resolveRequestUserMock,
  repoFindFirst,
  advisoryFindFirst,
  stateUpsert,
  stateDeleteMany,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  repoFindFirst: vi.fn(),
  advisoryFindFirst: vi.fn(),
  stateUpsert: vi.fn(),
  stateDeleteMany: vi.fn(),
}));

vi.mock('@/lib/auth-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-api')>('@/lib/auth-api');
  return { resolveRequestUser: resolveRequestUserMock, hasWriteScope: actual.hasWriteScope };
});
// The real auth-api module is loaded above only for its hasWriteScope predicate.
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    repo: { findFirst: repoFindFirst },
    advisory: { findFirst: advisoryFindFirst },
    advisoryState: { upsert: stateUpsert, deleteMany: stateDeleteMany },
  },
}));

import { PUT, DELETE } from '@/app/api/advisory-state/route';
import { NextRequest } from 'next/server';

function makeRequest(method: 'PUT' | 'DELETE', body: unknown, raw = false): NextRequest {
  return new NextRequest('http://localhost/api/advisory-state', {
    method,
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const target = { repoId: 'repo-1', ghsaId: 'GHSA-1', packageName: 'lodash' };
const user = { id: 'me', githubLogin: 'octocat', githubToken: 'gh', scope: 'WRITE' };

beforeEach(() => {
  resolveRequestUserMock.mockReset();
  repoFindFirst.mockReset();
  advisoryFindFirst.mockReset();
  stateUpsert.mockReset();
  stateDeleteMany.mockReset();
  resolveRequestUserMock.mockResolvedValue(user);
  repoFindFirst.mockResolvedValue({ id: 'repo-1' });
  advisoryFindFirst.mockResolvedValue({ id: 'adv-1' });
  stateUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    ...create,
    updatedAt: new Date('2026-02-01T00:00:00Z'),
  }));
  stateDeleteMany.mockResolvedValue({ count: 1 });
});

describe('PUT /api/advisory-state', () => {
  it('returns 401 without a user', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const res = await PUT(makeRequest('PUT', { ...target, status: 'IGNORED' }));
    expect(res.status).toBe(401);
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it('returns 403 for a READ-scoped token', async () => {
    resolveRequestUserMock.mockResolvedValue({ ...user, scope: 'READ' });
    const res = await PUT(makeRequest('PUT', { ...target, status: 'IGNORED' }));
    expect(res.status).toBe(403);
    expect(repoFindFirst).not.toHaveBeenCalled();
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{not json', true],
    ['a JSON array', [1, 2], false],
    ['missing repoId', { ghsaId: 'GHSA-1', packageName: 'lodash', status: 'IGNORED' }, false],
    ['missing ghsaId', { repoId: 'repo-1', packageName: 'lodash', status: 'IGNORED' }, false],
    ['blank packageName', { ...target, packageName: '  ', status: 'IGNORED' }, false],
    ['overlong ghsaId', { ...target, ghsaId: 'G'.repeat(201), status: 'IGNORED' }, false],
    ['non-string repoId', { ...target, repoId: 5, status: 'IGNORED' }, false],
  ])('returns 400 for %s', async (_label, body, raw) => {
    const res = await PUT(makeRequest('PUT', body, raw));
    expect(res.status).toBe(400);
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it.each(['OPEN', 'ignored', '', 7, undefined])('returns 400 for status %j', async (status) => {
    const res = await PUT(makeRequest('PUT', { ...target, status }));
    expect(res.status).toBe(400);
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it('returns 400 for a note that is not a string or is too long', async () => {
    for (const note of [5, 'n'.repeat(501)]) {
      const res = await PUT(makeRequest('PUT', { ...target, status: 'IGNORED', note }));
      expect(res.status).toBe(400);
    }
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it("returns 404 and writes nothing for another user's repository (IDOR)", async () => {
    // The ownership filter is part of the query: a repo of another user is simply not found.
    repoFindFirst.mockImplementation(async ({ where }: { where: { id: string; userId: string } }) =>
      where.userId === 'owner-of-repo-1' ? { id: where.id } : null,
    );
    const res = await PUT(makeRequest('PUT', { ...target, status: 'IGNORED' }));
    expect(res.status).toBe(404);
    expect(repoFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'repo-1', userId: 'me', tracked: true } }),
    );
    expect(advisoryFindFirst).not.toHaveBeenCalled();
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it('returns 404 for an advisory the repository never reported', async () => {
    advisoryFindFirst.mockResolvedValue(null);
    const res = await PUT(makeRequest('PUT', { ...target, status: 'IGNORED' }));
    expect(res.status).toBe(404);
    expect(advisoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ghsaId: 'GHSA-1', packageName: 'lodash', scan: { repoId: 'repo-1' } },
      }),
    );
    expect(stateUpsert).not.toHaveBeenCalled();
  });

  it('upserts the state with the caller as author and trims the note', async () => {
    const res = await PUT(makeRequest('PUT', { ...target, status: 'ACKNOWLEDGED', note: '  waiting for upstream  ' }));
    expect(res.status).toBe(200);
    expect(stateUpsert).toHaveBeenCalledWith({
      where: { repoId_ghsaId_packageName: { repoId: 'repo-1', ghsaId: 'GHSA-1', packageName: 'lodash' } },
      create: {
        repoId: 'repo-1',
        ghsaId: 'GHSA-1',
        packageName: 'lodash',
        status: 'ACKNOWLEDGED',
        note: 'waiting for upstream',
        setByUserId: 'me',
      },
      update: { status: 'ACKNOWLEDGED', note: 'waiting for upstream', setByUserId: 'me' },
    });
    const body = await res.json() as { state: Record<string, unknown> };
    expect(body.state).toMatchObject({
      ghsaId: 'GHSA-1',
      packageName: 'lodash',
      status: 'ACKNOWLEDGED',
      note: 'waiting for upstream',
      setBy: 'octocat',
    });
  });

  it('stores an empty note as null', async () => {
    const res = await PUT(makeRequest('PUT', { ...target, status: 'IGNORED', note: '   ' }));
    expect(res.status).toBe(200);
    expect(stateUpsert.mock.calls[0][0].create.note).toBeNull();
  });
});

describe('DELETE /api/advisory-state', () => {
  it('returns 401 without a user', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    expect((await DELETE(makeRequest('DELETE', target))).status).toBe(401);
    expect(stateDeleteMany).not.toHaveBeenCalled();
  });

  it('returns 403 for a READ-scoped token', async () => {
    resolveRequestUserMock.mockResolvedValue({ ...user, scope: 'READ' });
    expect((await DELETE(makeRequest('DELETE', target))).status).toBe(403);
    expect(stateDeleteMany).not.toHaveBeenCalled();
  });

  it('returns 400 for a body without the identity', async () => {
    expect((await DELETE(makeRequest('DELETE', { repoId: 'repo-1' }))).status).toBe(400);
    expect((await DELETE(makeRequest('DELETE', '{oops', true))).status).toBe(400);
    expect(stateDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 and deletes nothing for another user's repository (IDOR)", async () => {
    repoFindFirst.mockResolvedValue(null);
    const res = await DELETE(makeRequest('DELETE', target));
    expect(res.status).toBe(404);
    expect(repoFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'repo-1', userId: 'me', tracked: true } }),
    );
    expect(stateDeleteMany).not.toHaveBeenCalled();
  });

  it('clears only the one finding of the owned repository', async () => {
    const res = await DELETE(makeRequest('DELETE', target));
    expect(res.status).toBe(200);
    expect(stateDeleteMany).toHaveBeenCalledWith({
      where: { repoId: 'repo-1', ghsaId: 'GHSA-1', packageName: 'lodash' },
    });
    expect(await res.json()).toEqual({ success: true, cleared: true });
  });

  it('is idempotent when the finding had no state', async () => {
    stateDeleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(makeRequest('DELETE', target));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, cleared: false });
  });
});
