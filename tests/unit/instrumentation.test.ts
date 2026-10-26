import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startAutoScan = vi.fn();

vi.mock('@/lib/cron/auto-scan', () => ({ startAutoScan }));

describe('instrumentation register()', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  // What the auto-scan module's factory returns or throws on import. A test changes this
  // instead of calling vi.doMock again: a second doMock for the same path in one test
  // races the one from beforeEach (vitest resolves them asynchronously), and under load
  // the older factory could win.
  let autoScanModule: () => unknown;

  beforeEach(() => {
    vi.resetModules();
    autoScanModule = () => ({ startAutoScan });
    // A vi.doMock outlives resetModules, so every test starts from this one registration.
    vi.doMock('@/lib/cron/auto-scan', () => autoScanModule());
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
    autoScanModule = () => {
      throw new Error('Invalid SCAN_INTERVAL_MINUTES="0"');
    };
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

  describe('auth environment check', () => {
    const prodEnv = (secret: string, url: string) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXTAUTH_SECRET', secret);
      vi.stubEnv('NEXTAUTH_URL', url);
    };

    it('exits 1 before the auto-scan starts when the production secret is empty', async () => {
      prodEnv('', 'https://depsight.example.com');
      const { register } = await import('@/instrumentation');
      await register();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(startAutoScan).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Fatal configuration error'),
        expect.stringContaining('NEXTAUTH_SECRET'),
      );
    });

    it('exits 1 when the production URL is not absolute, without echoing it', async () => {
      prodEnv('s3cret-value-xyz', 'depsight-host-marker');
      const { register } = await import('@/instrumentation');
      await register();
      expect(exitSpy).toHaveBeenCalledWith(1);
      const logged = JSON.stringify(errorSpy.mock.calls);
      expect(logged).toContain('NEXTAUTH_URL');
      expect(logged).not.toContain('s3cret-value-xyz');
      expect(logged).not.toContain('depsight-host-marker');
    });

    it('starts normally in production with a valid secret and URL', async () => {
      prodEnv('s3cret-value-xyz', 'https://depsight.example.com');
      const { register } = await import('@/instrumentation');
      await register();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(startAutoScan).toHaveBeenCalledTimes(1);
    });

    it('starts with a warning in production on a localhost URL', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      prodEnv('s3cret-value-xyz', 'http://localhost:3000');
      const { register } = await import('@/instrumentation');
      await register();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(startAutoScan).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not check outside production (a missing secret is fine)', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXTAUTH_SECRET', '');
      vi.stubEnv('NEXTAUTH_URL', '');
      const { register } = await import('@/instrumentation');
      await register();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(startAutoScan).toHaveBeenCalledTimes(1);
    });

    it('does not check during the production build phase', async () => {
      prodEnv('', '');
      vi.stubEnv('NEXT_PHASE', 'phase-production-build');
      const { register } = await import('@/instrumentation');
      await register();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('still reports an invalid scan interval after a valid auth configuration', async () => {
      prodEnv('s3cret-value-xyz', 'https://depsight.example.com');
      startAutoScan.mockImplementation(() => {
        throw new Error('Invalid SCAN_INTERVAL_MINUTES="0"');
      });
      const { register } = await import('@/instrumentation');
      await register();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
