import { createHmac, timingSafeEqual } from 'node:crypto';
import { PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR } from '@/lib/rate-limit';

/**
 * Helpers for the inbound GitHub webhook (POST /api/webhooks/github): HMAC
 * signature check, capped raw-body read and a bounded delivery replay guard.
 * Pure of the request framework so each decision is unit-testable.
 */

/** pull_request payloads are tens of KB; anything above this is not one. */
export const MAX_BODY_BYTES = 1024 * 1024;

const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * True when `signatureHeader` (the `X-Hub-Signature-256` value, `sha256=<hex>`)
 * is the HMAC-SHA256 of `rawBody` under `secret`. The digests are compared with
 * timingSafeEqual on two 32-byte buffers; a header of any other shape (missing,
 * wrong prefix, wrong length, non-hex) is rejected before the comparison, so a
 * length mismatch can never reach timingSafeEqual (which throws on it).
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false;
  const match = SIGNATURE_PATTERN.exec(signatureHeader);
  if (!match) return false;
  const provided = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** True when `signatureHeader` has the `sha256=<64 hex>` shape; says nothing about validity. */
export function hasWellFormedSignature(signatureHeader: string | null): boolean {
  return signatureHeader !== null && SIGNATURE_PATTERN.test(signatureHeader);
}

/**
 * Reads the request body as raw bytes, stopping as soon as more than
 * `maxBytes` have arrived. Returns null when the cap is exceeded, so an
 * unauthenticated caller can never make the server buffer more than the cap.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<Buffer | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  if (!req.body) return Buffer.alloc(0);

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The stream is already being dropped; nothing to recover.
      }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export interface DeliveryGuard {
  /** True while `key` was remembered less than the TTL ago. */
  has(key: string): boolean;
  /** Remember `key`; the oldest entries go first once the cap is reached. */
  remember(key: string): void;
  /** Forget `key` (a delivery whose scan failed may be redelivered). */
  forget(key: string): void;
  /** Number of remembered keys, expired ones not yet dropped included. */
  size(): number;
  /** The hard cap on remembered keys. */
  capacity(): number;
  reset(): void;
}

/**
 * Bounded in-memory replay guard. State lives in this Node process only:
 * a restart forgets it, and with several app instances each one keeps its
 * own set (depsight runs a single instance, see lib/rate-limit.ts). The
 * cost of a miss is one repeated scan, which is bounded by the webhook rate
 * limit and rewrites the same PR comment, so no shared store is used.
 */
export function createDeliveryGuard(options: { ttlMs: number; maxEntries: number }): DeliveryGuard {
  const { ttlMs, maxEntries } = options;
  // Map iteration order is insertion order, so the first key is the oldest.
  const seen = new Map<string, number>();

  return {
    has(key: string): boolean {
      const expiresAt = seen.get(key);
      if (expiresAt === undefined) return false;
      if (expiresAt <= Date.now()) {
        seen.delete(key);
        return false;
      }
      return true;
    },
    remember(key: string): void {
      const now = Date.now();
      seen.delete(key);
      seen.set(key, now + ttlMs);
      // Every entry has the same TTL, so insertion order is expiry order: drop
      // expired entries from the front, then enforce the hard cap.
      for (const [oldKey, expiresAt] of seen) {
        if (expiresAt > now && seen.size <= maxEntries) break;
        seen.delete(oldKey);
      }
    },
    forget(key: string): void {
      seen.delete(key);
    },
    size(): number {
      return seen.size;
    },
    capacity(): number {
      return maxEntries;
    },
    reset(): void {
      seen.clear();
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Replay guard of POST /api/webhooks/github. 24 hours covers GitHub's manual
 * redelivery window for a delivery that was seen. The capacity is derived from
 * the endpoint's rate limit so the 24 hours hold even at the full rate: at most
 * PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR accepted deliveries per hour, two keys
 * each (delivery id and body digest). The limiter uses fixed hourly windows, so
 * a 24-hour TTL that starts inside a window can span 25 of them.
 */
export const PR_WEBHOOK_DELIVERY_TTL_MS = DAY_MS;
export const PR_WEBHOOK_DELIVERY_MAX_ENTRIES = 2 * PR_SCAN_WEBHOOK_TOTAL_LIMIT_PER_HOUR * (24 + 1);
export const prWebhookDeliveries = createDeliveryGuard({
  ttlMs: PR_WEBHOOK_DELIVERY_TTL_MS,
  maxEntries: PR_WEBHOOK_DELIVERY_MAX_ENTRIES,
});
