// The degraded-source tracker (lib/scan/degraded.ts): what counts as "nothing
// there", how sources report, and that parallel scopes never see each other.
import { describe, it, expect } from 'vitest';
import { isNothingThere, noteDegraded, trackDegraded } from '@/lib/scan/degraded';

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

describe('isNothingThere', () => {
  it('treats a 404 as nothing there', () => {
    expect(isNothingThere(httpError(404, 'Not Found'))).toBe(true);
  });

  it('treats a 409 on an empty repository as nothing there, but not any other 409', () => {
    expect(isNothingThere(httpError(409, 'Git Repository is empty.'))).toBe(true);
    expect(isNothingThere(httpError(409, 'Conflict: merge in progress'))).toBe(false);
  });

  it.each([401, 403, 429, 500, 502, 503])('treats a %i as an unreadable source', (status) => {
    expect(isNothingThere(httpError(status, 'nope'))).toBe(false);
  });

  it('treats an error without a status (network, timeout) as an unreadable source', () => {
    expect(isNothingThere(new Error('fetch failed'))).toBe(false);
    expect(isNothingThere('boom')).toBe(false);
    expect(isNothingThere(undefined)).toBe(false);
  });
});

describe('trackDegraded', () => {
  it('reports null when no source was unreadable', async () => {
    const { value, degraded } = await trackDegraded(async () => 42);
    expect(value).toBe(42);
    expect(degraded).toBeNull();
  });

  it('names each unreadable source once, with its HTTP status', async () => {
    const { degraded } = await trackDegraded(async () => {
      noteDegraded('GitHub file read', httpError(401, 'Bad credentials'));
      noteDegraded('GitHub file read', httpError(401, 'Bad credentials'));
      noteDegraded('OSV querybatch', 'HTTP 503');
      noteDegraded('OSV scan', new Error('fetch failed'));
    });
    expect(degraded).toBe(
      'GitHub file read: HTTP 401: Bad credentials; OSV querybatch: HTTP 503; OSV scan: fetch failed',
    );
  });

  it('caps the named reasons and counts the rest', async () => {
    const { degraded } = await trackDegraded(async () => {
      for (let i = 0; i < 8; i += 1) noteDegraded(`source ${i}`, 'HTTP 500');
    });
    expect(degraded?.split('; ')).toHaveLength(6);
    expect(degraded).toMatch(/; \+3 more$/);
  });

  it('noteDegraded outside a scope does nothing and does not throw', () => {
    expect(() => noteDegraded('GitHub file read', httpError(500, 'x'))).not.toThrow();
  });

  it('a reason noted after a scope closed does not leak into it', async () => {
    const first = await trackDegraded(async () => 1);
    noteDegraded('late source', 'HTTP 500');
    expect(first.degraded).toBeNull();
  });

  it('scopes running in parallel each see only their own sources', async () => {
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 5));
    const [a, b, c] = await Promise.all([
      trackDegraded(async () => {
        await gate;
        noteDegraded('A source', 'HTTP 401');
      }),
      trackDegraded(async () => {
        noteDegraded('B source', 'HTTP 500');
        await gate;
      }),
      trackDegraded(async () => {
        await gate;
      }),
    ]);
    expect(a.degraded).toBe('A source: HTTP 401');
    expect(b.degraded).toBe('B source: HTTP 500');
    expect(c.degraded).toBeNull();
  });
});
