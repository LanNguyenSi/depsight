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

  it('(2) returns 503 with status:degraded and db:unreachable when $queryRaw throws, without the error text', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryRawMock.mockRejectedValue(
      new Error("Can't reach database server at `db.internal:5432`"),
    );

    const res = await GET();

    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('unreachable');
    expect(Object.keys(body).sort()).toEqual(['db', 'status', 'timestamp']);
    expect(body).not.toHaveProperty('error');
    expect(typeof body.timestamp).toBe('string');
    expect(body.timestamp).toBeTruthy();
    // No part of the driver message (host, port) reaches the unauthenticated body.
    expect(text).not.toContain('db.internal');
    expect(text).not.toContain('5432');
    // It is logged server side instead.
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0].join(' ')).toContain('db.internal:5432');
    errorLog.mockRestore();
  });

  it('(3) answers a non-Error rejection the same way and logs a generic message', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryRawMock.mockRejectedValue('raw string error');

    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('error');
    expect(body.db).toBe('unreachable');
    expect(errorLog.mock.calls[0].join(' ')).toContain('Unknown database error');
    errorLog.mockRestore();
  });
});
