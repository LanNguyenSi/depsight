import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Per-repository secret of the inbound GitHub PR-scan webhook.
 *
 * HMAC verification needs the plaintext secret, so it cannot be hashed. It is
 * sealed at rest with AES-256-GCM instead. The key is derived (HKDF-SHA256)
 * from `WEBHOOK_SECRET_KEY` or, when that is unset, from `NEXTAUTH_SECRET`,
 * which every deployment already has. The row id is bound in as additional
 * authenticated data, so a sealed value copied onto another row does not
 * open. The plaintext is shown once, when it is generated.
 *
 * Stored format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */

const FORMAT_VERSION = 'v1';
const KEY_INFO = 'depsight webhook secret v1';
const KEY_SALT = 'depsight';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Random secret handed to the user: 32 bytes, hex (64 characters). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The 32-byte sealing key, or null when neither `WEBHOOK_SECRET_KEY` nor
 * `NEXTAUTH_SECRET` is set (blank counts as unset). Callers treat null as
 * "feature unavailable" and fail closed.
 */
export function getWebhookSecretKey(): Buffer | null {
  const material = [process.env.WEBHOOK_SECRET_KEY, process.env.NEXTAUTH_SECRET].find(
    (value) => value !== undefined && value.trim() !== '',
  );
  if (material === undefined) return null;
  return Buffer.from(hkdfSync('sha256', material, KEY_SALT, KEY_INFO, 32));
}

function aad(repoId: string): Buffer {
  return Buffer.from(`depsight:webhook-secret:${repoId}`, 'utf8');
}

/** Seals `secret` for the repo row `repoId`. Throws when no key is configured. */
export function sealWebhookSecret(secret: string, repoId: string): string {
  const key = getWebhookSecretKey();
  if (!key) throw new Error('No webhook secret key configured');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(repoId));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Opens a value sealed for `repoId`. Returns null, never throws, when the value
 * is malformed, was sealed for another row, was tampered with, or was sealed
 * under a different key (for example after `NEXTAUTH_SECRET` changed).
 */
export function openWebhookSecret(sealed: string, repoId: string): string | null {
  const key = getWebhookSecretKey();
  if (!key) return null;
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(repoId));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return plain === '' ? null : plain;
  } catch {
    return null;
  }
}

/** Operator warning for a stored secret that does not open; names only the row id, never key material or the stored value. */
export function unreadableSecretWarning(rowId: string): string {
  return (
    `PR scan webhook: the stored secret of repository row ${rowId} cannot be opened ` +
    '(the key material changed or the value is damaged); rotate it in Settings'
  );
}

/** Operator warning that the removed instance-wide variable is still set; never includes its value. */
export const IGNORED_INSTANCE_SECRET_WARNING =
  'GITHUB_WEBHOOK_SECRET is ignored: webhook secrets are per repository now; ' +
  'mint secrets in Settings and update each GitHub webhook';
