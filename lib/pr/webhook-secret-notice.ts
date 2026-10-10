/**
 * Which hint the settings page shows next to a tracked repository's webhook
 * secret. Without key material nothing opens, so the one operator notice
 * replaces the per-row "rotate it" hint: rotating cannot help until the
 * operator sets a key.
 */
export function showRotateHint(available: boolean, row: { configured: boolean; usable: boolean }): boolean {
  return available && row.configured && !row.usable;
}
