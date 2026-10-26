import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertAuthEnv, checkAuthEnv } from '@/lib/auth-env';

const SECRET = 'a-very-secret-value-0f3a';
const URLS = {
  absent: undefined,
  empty: '',
  whitespace: '   ',
  relative: '/depsight',
  bareHost: 'depsight.example.com',
  hostPort: 'localhost:3000',
  ftp: 'ftp://depsight.example.com',
  absolute: 'https://depsight.example.com',
  absoluteHttp: 'http://depsight.example.com:8080',
} as const;

const env = (nodeEnv: string | undefined, secret: string | undefined, url: string | undefined) => ({
  NODE_ENV: nodeEnv,
  NEXTAUTH_SECRET: secret,
  NEXTAUTH_URL: url,
});

describe('checkAuthEnv in production: NEXTAUTH_SECRET', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('is an error when the secret is %s, with a valid URL', (_label, secret) => {
    const report = checkAuthEnv(env('production', secret, URLS.absolute));
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('NEXTAUTH_SECRET');
    expect(report.warnings).toEqual([]);
  });

  it('passes when the secret is set and the URL is absolute', () => {
    expect(checkAuthEnv(env('production', SECRET, URLS.absolute))).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('keeps a secret with surrounding whitespace valid (only a blank value fails)', () => {
    expect(checkAuthEnv(env('production', ` ${SECRET} `, URLS.absolute)).errors).toEqual([]);
  });
});

describe('checkAuthEnv in production: NEXTAUTH_URL', () => {
  it.each([
    ['absent', URLS.absent],
    ['empty', URLS.empty],
    ['whitespace only', URLS.whitespace],
    ['a relative path', URLS.relative],
    ['a bare host name', URLS.bareHost],
    ['host:port without a scheme', URLS.hostPort],
    ['a non-http scheme', URLS.ftp],
  ])('is an error when the URL is %s, with a set secret', (_label, url) => {
    const report = checkAuthEnv(env('production', SECRET, url));
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('NEXTAUTH_URL');
    expect(report.warnings).toEqual([]);
  });

  it.each([
    ['https', URLS.absolute],
    ['http with a port', URLS.absoluteHttp],
  ])('accepts an absolute %s URL', (_label, url) => {
    expect(checkAuthEnv(env('production', SECRET, url))).toEqual({ errors: [], warnings: [] });
  });

  it.each([
    'http://localhost:3000',
    'https://localhost',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://0.0.0.0:3000',
    'http://app.localhost:3000',
  ])('warns, and does not fail, for the loopback URL %s', (url) => {
    const report = checkAuthEnv(env('production', SECRET, url));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('NEXTAUTH_URL');
  });

  it('does not treat a public host that merely contains "localhost" as loopback', () => {
    expect(
      checkAuthEnv(env('production', SECRET, 'https://localhost.example.com')).warnings,
    ).toEqual([]);
  });
});

describe('checkAuthEnv in production: both variables together', () => {
  it('reports both problems when the secret and the URL are unusable', () => {
    const report = checkAuthEnv(env('production', undefined, URLS.relative));
    expect(report.errors).toHaveLength(2);
    expect(report.errors.join(' ')).toContain('NEXTAUTH_SECRET');
    expect(report.errors.join(' ')).toContain('NEXTAUTH_URL');
  });

  it('a bad secret still fails when the URL is only a loopback warning', () => {
    const report = checkAuthEnv(env('production', '', 'http://localhost:3000'));
    expect(report.errors).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
  });

  it('never puts a variable value into a message', () => {
    const cases = [
      env('production', SECRET, 'not a url with-secret-token-9z'),
      env('production', '', 'http://localhost:3000/secret-path-1q'),
      env('production', SECRET, 'ftp://secret-host-4k.example.com'),
    ];
    for (const c of cases) {
      const text = JSON.stringify(checkAuthEnv(c));
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('with-secret-token-9z');
      expect(text).not.toContain('secret-path-1q');
      expect(text).not.toContain('secret-host-4k');
    }
  });
});

describe('checkAuthEnv outside production', () => {
  it.each([['development'], ['test'], [undefined], ['staging']])(
    'checks nothing with NODE_ENV=%s, even with no secret and a relative URL',
    (nodeEnv) => {
      expect(checkAuthEnv(env(nodeEnv, undefined, URLS.relative))).toEqual({
        errors: [],
        warnings: [],
      });
      expect(checkAuthEnv(env(nodeEnv, '', 'http://localhost:3000'))).toEqual({
        errors: [],
        warnings: [],
      });
    },
  );
});

describe('assertAuthEnv', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws one error naming every failing variable', () => {
    expect(() => assertAuthEnv(env('production', '', 'depsight.example.com'))).toThrow(
      /NEXTAUTH_SECRET.*NEXTAUTH_URL/s,
    );
  });

  it('logs a loopback warning and does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => assertAuthEnv(env('production', SECRET, 'http://localhost:3000'))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('[startup]');
  });

  it('is silent for a valid production configuration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => assertAuthEnv(env('production', SECRET, URLS.absolute))).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads process.env by default', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXTAUTH_SECRET', '');
    vi.stubEnv('NEXTAUTH_URL', URLS.absolute);
    try {
      expect(() => assertAuthEnv()).toThrow(/NEXTAUTH_SECRET/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
