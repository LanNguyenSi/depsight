// Route-level tests for GET /api/health.
// Public endpoint — no auth. Mocks only prisma.$queryRaw.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { queryRawMock } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: queryRawMock,
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/health/route';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/health', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
  });

  it('(1) returns 200 with status:ok and db:ok when $queryRaw resolves', async () => {
    queryRawMock.mockResolvedValue([{ 1: 1 }]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; db: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(body.timestamp).toBeTruthy();
  });

  it('(2) returns 503 with status:degraded and db:unreachable when $queryRaw throws', async () => {
    queryRawMock.mockRejectedValue(new Error('Connection refused'));

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json() as { status: string; db: string; error: string; timestamp: string };
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('unreachable');
    expect(body.error).toBe('Connection refused');
    expect(typeof body.timestamp).toBe('string');
    expect(body.timestamp).toBeTruthy();
  });

  it('(3) includes non-Error rejection message as Unknown database error', async () => {
    queryRawMock.mockRejectedValue('raw string error');

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unknown database error');
  });
});
