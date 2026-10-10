/**
 * The instance default for scanning fork pull requests
 * (GITHUB_WEBHOOK_SCAN_FORKS): forks are scanned only when it is `true`
 * (trimmed, case-insensitive). The webhook route applies it and the settings
 * API shows it, so both read it through this one function.
 */
export function scanForksDefault(): boolean {
  return process.env.GITHUB_WEBHOOK_SCAN_FORKS?.trim().toLowerCase() === 'true';
}
