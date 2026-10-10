import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startAutoScan = vi.fn();

vi.mock('@/lib/cron/auto-scan', () => ({ startAutoScan }));

describe('instrumentation register()', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    startAutoScan.mockReset();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('starts the auto-scan and does not exit on a valid configuration', async () => {
    const { register } = await import('@/instrumentation');
    await register();
    expect(startAutoScan).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero when startup throws a configuration error', async () => {
    startAutoScan.mockImplementation(() => {
      throw new Error('Invalid SCAN_INTERVAL_MINUTES="0"');
    });
    const { register } = await import('@/instrumentation');
    await register();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fatal configuration error'),
      expect.stringContaining('SCAN_INTERVAL_MINUTES'),
    );
  });

  it('exits non-zero when importing the module throws (the real invalid-env path)', async () => {
    vi.doMock('@/lib/cron/auto-scan', () => {
      throw new Error('Invalid SCAN_INTERVAL_MINUTES="0"');
    });
    const { register } = await import('@/instrumentation');
    await register();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does nothing outside the node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await import('@/instrumentation');
    await register();
    expect(startAutoScan).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
