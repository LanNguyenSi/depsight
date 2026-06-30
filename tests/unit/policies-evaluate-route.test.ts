// Route-level tests for POST /api/policies/evaluate.
// Covers 401, scanId validation (missing/non-string/whitespace), count===violations.length,
// scanId trimming, and 500 path.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  resolveRequestUserMock,
  evaluatePoliciesMock,
} = vi.hoisted(() => ({
  resolveRequestUserMock: vi.fn(),
  evaluatePoliciesMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (before any imports)
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth-api', () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock('@/lib/policy/engine', () => ({
  evaluatePolicies: evaluatePoliciesMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { POST } from '@/app/api/policies/evaluate/route';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockUser = { id: 'user-1', githubLogin: 'octocat', githubToken: 'gh_tok' };

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/policies/evaluate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /api/policies/evaluate', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    evaluatePoliciesMock.mockReset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('returns 401 when unauthenticated', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    const res = await POST(makeRequest({ scanId: 'scan-1' }));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 400 when scanId is missing from body', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('scanId is required');
  });

  it('returns 400 when scanId is a non-string value (number)', async () => {
    const res = await POST(makeRequest({ scanId: 42 }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('scanId is required');
  });

  it('returns 400 when scanId is a whitespace-only string', async () => {
    const res = await POST(makeRequest({ scanId: '   ' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('scanId is required');
  });

  it('returns 400 when scanId is null', async () => {
    const res = await POST(makeRequest({ scanId: null }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('scanId is required');
  });

  it('returns 200 with violations and count===violations.length, verifies evaluatePolicies args', async () => {
    const violations = [
      { id: 'v1', policyName: 'no-critical', severity: 'HIGH' },
      { id: 'v2', policyName: 'license-check', severity: 'MEDIUM' },
    ];
    evaluatePoliciesMock.mockResolvedValue(violations);
    const res = await POST(makeRequest({ scanId: 'scan-1' }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      violations: typeof violations;
      count: number;
    };
    expect(body.violations).toEqual(violations);
    expect(body.count).toBe(2);
    // count must exactly match violations.length — mutation kills both at once
    expect(body.count).toBe(body.violations.length);
    expect(evaluatePoliciesMock).toHaveBeenCalledWith('user-1', 'scan-1');
  });

  it('trims scanId before passing to evaluatePolicies', async () => {
    evaluatePoliciesMock.mockResolvedValue([]);
    const res = await POST(makeRequest({ scanId: '  scan-padded  ' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number };
    expect(body.count).toBe(0);
    // Must have been called with the trimmed value
    expect(evaluatePoliciesMock).toHaveBeenCalledWith('user-1', 'scan-padded');
  });

  it('returns 500 with error message when evaluatePolicies throws', async () => {
    evaluatePoliciesMock.mockRejectedValue(new Error('engine error'));
    const res = await POST(makeRequest({ scanId: 'scan-1' }));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('engine error');
  });
});
