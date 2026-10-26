/**
 * Startup check for the two variables that sign users in. In production a missing
 * session secret or an unusable public URL leaves a server that passes the database
 * health check and then fails every login, so the process refuses to start instead
 * (the same exit-1 path as an invalid SCAN_INTERVAL_MINUTES).
 *
 * Names: this checks NEXTAUTH_SECRET and NEXTAUTH_URL, the names depsight reads (webhook
 * sealing reads NEXTAUTH_SECRET only). next-auth v5's AUTH_SECRET and AUTH_URL are not
 * looked at.
 *
 * Only NODE_ENV=production is checked: development and test runs have their own
 * defaults (docker-compose.dev.yml sets both) and the Docker image build sets no
 * runtime variables at all.
 */

export interface AuthEnvReport {
  errors: string[];
  warnings: string[];
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * Judge the auth variables in `env`. Outside production the report is empty.
 *
 * - NEXTAUTH_SECRET unset, empty or whitespace only: error.
 * - NEXTAUTH_URL unset, empty, not parseable or not http(s): error. A relative value
 *   such as `/depsight` or a bare host such as `depsight.example.com` is not absolute.
 * - NEXTAUTH_URL on localhost, 127.0.0.1, ::1, 0.0.0.0 or *.localhost: warning only. The
 *   self-hosting compose file publishes port 3000, so a local instance legitimately
 *   signs in on localhost; behind a public host name it is the .env.example default
 *   that was never changed, which the warning names.
 *
 * Error messages name the variable and never include its value.
 */
export function checkAuthEnv(env: Record<string, string | undefined>): AuthEnvReport {
  const report: AuthEnvReport = { errors: [], warnings: [] };
  if (env.NODE_ENV !== 'production') return report;

  if ((env.NEXTAUTH_SECRET ?? '').trim() === '') {
    report.errors.push(
      'NEXTAUTH_SECRET is not set or empty: sessions cannot be signed (generate one with: openssl rand -base64 32)',
    );
  }

  const rawUrl = (env.NEXTAUTH_URL ?? '').trim();
  if (rawUrl === '') {
    report.errors.push(
      'NEXTAUTH_URL is not set or empty: it must be the public base URL of the app, for example https://depsight.example.com',
    );
  } else {
    let url: URL | null = null;
    try {
      url = new URL(rawUrl);
    } catch {
      url = null;
    }
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      report.errors.push(
        'NEXTAUTH_URL is not an absolute http(s) URL: it must be the public base URL of the app, for example https://depsight.example.com',
      );
    } else if (isLoopbackHost(url.hostname)) {
      report.warnings.push(
        `NEXTAUTH_URL points at ${url.hostname}: OAuth callbacks and sign-in only work from this machine. Set it to the public URL unless this instance is reached locally on purpose`,
      );
    }
  }
  return report;
}

/** Log warnings, throw one Error listing every problem. Called from instrumentation.ts. */
export function assertAuthEnv(env: Record<string, string | undefined> = process.env): void {
  const { errors, warnings } = checkAuthEnv(env);
  for (const warning of warnings) console.warn(`[startup] ${warning}`);
  if (errors.length > 0) throw new Error(errors.join('; '));
}
