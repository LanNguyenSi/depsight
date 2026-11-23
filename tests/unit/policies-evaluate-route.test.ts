// Route-level tests for POST /api/policies/evaluate.
// Covers 401, scanId validation (missing/non-string/whitespace), count===violations.length,
// scanId trimming, and 500 path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { DEFAULT_JSON_BODY_BYTES } from '@/lib/http/read-json-capped';
import {
  policyEvaluateRateLimiter,
  POLICY_EVALUATE_LIMIT_PER_HOUR,
} from '@/lib/rate-limit';

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
    policyEvaluateRateLimiter.reset();
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

describe('POST /api/policies/evaluate: request body cap', () => {
  beforeEach(() => {
    resolveRequestUserMock.mockReset();
    evaluatePoliciesMock.mockReset();
    policyEvaluateRateLimiter.reset();
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  it('answers 413 for a body over the cap and evaluates nothing', async () => {
    const res = await POST(makeRequest({ scanId: 'scan-1', padding: 'x'.repeat(DEFAULT_JSON_BODY_BYTES) }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(evaluatePoliciesMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/policies/evaluate: per-user rate limit
// ---------------------------------------------------------------------------
describe('POST /api/policies/evaluate: per-user rate limit', () => {
  const WINDOW_MS = 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    policyEvaluateRateLimiter.reset();
    resolveRequestUserMock.mockReset();
    evaluatePoliciesMock.mockReset();
    evaluatePoliciesMock.mockResolvedValue([]);
    resolveRequestUserMock.mockResolvedValue(mockUser);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('budgets 300 evaluations per user and hour', () => {
    expect(POLICY_EVALUATE_LIMIT_PER_HOUR).toBe(300);
  });

  it('answers 429 with Retry-After on the (limit+1)th call and evaluates nothing', async () => {
    for (let i = 0; i < POLICY_EVALUATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makeRequest({ scanId: 'scan-1' }))).status).toBe(200);
    }
    expect(evaluatePoliciesMock).toHaveBeenCalledTimes(POLICY_EVALUATE_LIMIT_PER_HOUR);

    const res = await POST(makeRequest({ scanId: 'scan-1' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(WINDOW_MS / 1000));
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body).toEqual({ error: 'Rate limit exceeded', retryAfterSeconds: WINDOW_MS / 1000 });
    expect(evaluatePoliciesMock).toHaveBeenCalledTimes(POLICY_EVALUATE_LIMIT_PER_HOUR);
  });

  it('limits per user and does not count an unauthenticated request', async () => {
    resolveRequestUserMock.mockResolvedValue(null);
    for (let i = 0; i < POLICY_EVALUATE_LIMIT_PER_HOUR + 3; i++) {
      expect((await POST(makeRequest({ scanId: 'scan-1' }))).status).toBe(401);
    }

    resolveRequestUserMock.mockResolvedValue(mockUser);
    for (let i = 0; i < POLICY_EVALUATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makeRequest({ scanId: 'scan-1' }))).status).toBe(200);
    }
    expect((await POST(makeRequest({ scanId: 'scan-1' }))).status).toBe(429);

    resolveRequestUserMock.mockResolvedValue({ ...mockUser, id: 'someone-else' });
    expect((await POST(makeRequest({ scanId: 'scan-1' }))).status).toBe(200);
  });

  it('runs the limiter before validation: an over-budget body with a missing scanId answers 429 without evaluating', async () => {
    for (let i = 0; i < POLICY_EVALUATE_LIMIT_PER_HOUR; i++) {
      expect((await POST(makeRequest({ scanId: 'scan-1' }))).status).toBe(200);
    }
    evaluatePoliciesMock.mockClear();

    // A body without scanId would fail validation (400) if the limiter ran
    // after validation; the limiter is first, so this is 429 and no evaluation.
    const res = await POST(makeRequest({}));

    expect(res.status).toBe(429);
    expect(evaluatePoliciesMock).not.toHaveBeenCalled();
  });

  // Raw bodies the body reader or the first validation would reject: once the
  // budget is spent the limiter must answer first, so these are 429.
  describe('limiter runs before the body is read', () => {
    const rawRequest = (body: string): NextRequest =>
      new NextRequest('http://localhost/api/policies/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

    async function spendBudget(): Promise<void> {
      for (let i = 0; i < POLICY_EVALUATE_LIMIT_PER_HOUR; i++) {
        expect((await POST(makeRequest({ scanId: 'scan-1' }))).status).toBe(200);
      }
      evaluatePoliciesMock.mockClear();
    }

    it('answers 429, not a parse error, for malformed JSON once the budget is spent', async () => {
      await spendBudget();

      const res = await POST(rawRequest('{not json'));

      expect(res.status).toBe(429);
      expect(evaluatePoliciesMock).not.toHaveBeenCalled();
    });

    it('answers 429, not 413, for a body over the read cap once the budget is spent', async () => {
      await spendBudget();

      const res = await POST(rawRequest(JSON.stringify({ pad: 'x'.repeat(DEFAULT_JSON_BODY_BYTES) })));

      expect(res.status).toBe(429);
      expect(evaluatePoliciesMock).not.toHaveBeenCalled();
    });
  });
});
