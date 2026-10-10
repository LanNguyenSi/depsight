/**
 * Which hint the settings page shows next to a tracked repository's webhook
 * secret. Without key material nothing opens, so the one operator notice
 * replaces the per-row "rotate it" hint: rotating cannot help until the
 * operator sets a key.
 */
export function showRotateHint(available: boolean, row: { configured: boolean; usable: boolean }): boolean {
  return available && row.configured && !row.usable;
}

/**
 * State of the fork-scanning control of one row on the settings page. Without
 * a stored secret the webhook cannot verify a delivery, so the whole control
 * has no effect and is disabled. On a public repository the webhook ignores
 * "Scan" but still honours "Ignore" (the only setting that keeps protecting a
 * public repository when the instance default scans forks), so the select
 * stays usable there and only the "Scan" option is disabled.
 */
export function forkControlState(row: { configured: boolean; private: boolean }): {
  selectDisabled: boolean;
  scanDisabled: boolean;
  note: 'none' | 'noSecret' | 'publicScanIgnored';
} {
  if (!row.configured) return { selectDisabled: true, scanDisabled: false, note: 'noSecret' };
  if (!row.private) return { selectDisabled: false, scanDisabled: true, note: 'publicScanIgnored' };
  return { selectDisabled: false, scanDisabled: false, note: 'none' };
}
