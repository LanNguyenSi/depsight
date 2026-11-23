// Unit tests for lib/http/server-error.ts, the shared 500 answer of the
// authenticated routes: the raw error message goes to the server log with the
// route tag, the body carries only the route's fixed fallback text.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serverError } from '@/lib/http/server-error';

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Every string console.error was called with, joined for "not leaked" checks. */
function logged(): string {
  return errorSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

describe('serverError', () => {
  it('answers 500 with the fixed fallback, not the error message', async () => {
    const res = serverError('export', 'Export failed', new Error('secret internals'));

    expect(res.status).toBe(500);
    const body = await bodyOf(res);
    expect(body).toEqual({ error: 'Export failed' });
    expect(JSON.stringify(body)).not.toContain('secret internals');
  });

  it('logs the message once, prefixed with the route tag', () => {
    serverError('repos/sync', 'Sync failed', new Error('Bad credentials'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[repos/sync] Bad credentials');
  });

  it('logs only the message, never the stack', () => {
    const error = new Error('secret internals');
    error.stack = 'STACK-MARKER\n    at handler (app/api/export/route.ts:41:7)';

    serverError('export', 'Export failed', error);

    const out = logged();
    expect(out).toContain('[export] secret internals');
    expect(out).not.toContain('STACK-MARKER');
    expect(out).not.toContain('app/api/export/route.ts');
  });

  it('logs each route under its own tag', () => {
    serverError('scan', 'Scan failed', new Error('a'));
    serverError('sbom', 'SBOM generation failed', new Error('b'));

    expect(errorSpy.mock.calls.map((c) => c[0])).toEqual(['[scan] a', '[sbom] b']);
  });

  it('answers 500 with the fallback for a non-Error throw and logs a placeholder', async () => {
    for (const thrown of ['plain string', { code: 42 }, undefined, null, 0]) {
      errorSpy.mockClear();

      const res = serverError('overview', 'Failed to load overview', thrown);

      expect(res.status).toBe(500);
      expect(await bodyOf(res)).toEqual({ error: 'Failed to load overview' });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('[overview] Unknown error');
    }
  });

  it('keeps the fallback distinct per route when the same error is thrown', async () => {
    const error = new Error('db down');

    const deps = serverError('deps', 'Dependency analysis failed', error);
    const evaluate = serverError('policies/evaluate', 'Evaluation failed', error);

    expect(await bodyOf(deps)).toEqual({ error: 'Dependency analysis failed' });
    expect(await bodyOf(evaluate)).toEqual({ error: 'Evaluation failed' });
    expect(errorSpy.mock.calls.map((c) => c[0])).toEqual([
      '[deps] db down',
      '[policies/evaluate] db down',
    ]);
  });

  it('logs an Error with an empty message as the empty detail', () => {
    serverError('ci/sync', 'Sync failed', new Error(''));

    expect(errorSpy).toHaveBeenCalledWith('[ci/sync] ');
  });

  it('prefers an Error message over the placeholder even for a subclass', () => {
    class DownstreamError extends Error {
      constructor() {
        super('upstream said no');
        this.name = 'DownstreamError';
      }
    }

    serverError('license', 'License scan failed', new DownstreamError());

    expect(errorSpy).toHaveBeenCalledWith('[license] upstream said no');
  });
});
