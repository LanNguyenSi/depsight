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
 * a stored secret the webhook cannot verify a delivery, so the setting has no
 * effect; on a public repository the opt-in is ignored by the webhook.
 */
export function forkControlState(row: {
  configured: boolean;
  private: boolean;
}): 'editable' | 'noSecret' | 'publicIgnored' {
  if (!row.configured) return 'noSecret';
  if (!row.private) return 'publicIgnored';
  return 'editable';
}
