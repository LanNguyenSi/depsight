import crypto from 'node:crypto';

/** Prefix of every depsight API token ("Depsight API Token"). */
export const API_TOKEN_PREFIX = 'dsat_';

/** A fresh raw API token: the prefix plus 32 random bytes in hex (256 bits). */
export function generateApiToken(): string {
  return API_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

/**
 * What `ApiToken.token` holds: the lowercase hex SHA-256 of the raw token.
 * The raw value carries 256 bits of entropy, so a plain unsalted digest cannot
 * be guessed or precomputed and needs no pepper or slow hash; its job is that a
 * database dump or backup no longer contains a usable token. A digest never
 * starts with `dsat_`, which is how the pre-push SQL tells an unmigrated row
 * (prisma/pre-push/advisory-unique-key.sql) from a migrated one.
 */
export function hashApiToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}
