import { prisma } from '@/lib/prisma';
import { getUserRepos } from '@/lib/github';
import { syncUserRepos } from '@/lib/repos/sync';
import { scanRepository } from '@/lib/cve/scanner';
import { scanLicenses } from '@/lib/license/scanner';
import { scanDependencies } from '@/lib/deps/scanner';
import { syncAllUserRepos } from '@/lib/ci/sync';

const DEFAULT_INTERVAL_MINUTES = 60;
// setInterval stores its delay in a signed 32-bit integer; a larger delay
// silently falls back to 1 ms and would scan in a tight loop.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
export const MAX_SCAN_INTERVAL_MINUTES = Math.floor(MAX_TIMER_DELAY_MS / 60_000);

/**
 * Parse SCAN_INTERVAL_MINUTES. Unset or blank means the default. Anything else
 * must be a positive whole number of minutes no larger than
 * MAX_SCAN_INTERVAL_MINUTES; otherwise this throws so the misconfiguration
 * fails at startup instead of producing a runaway timer.
 */
export function parseScanIntervalMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MINUTES;
  const text = raw.trim();
  const minutes = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_SCAN_INTERVAL_MINUTES) {
    throw new Error(
      `Invalid SCAN_INTERVAL_MINUTES=${JSON.stringify(raw)}: expected a whole number of minutes between 1 and ${MAX_SCAN_INTERVAL_MINUTES}`,
    );
  }
  return minutes;
}

const INTERVAL_MS = parseScanIntervalMinutes(process.env.SCAN_INTERVAL_MINUTES) * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function isRateLimited(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return msg.includes('rate limit') || msg.includes('403') || msg.includes('secondary rate');
}

async function runAutoScan() {
  if (running) {
    console.log('[auto-scan] Previous run still active, skipping');
    return;
  }
  running = true;
  const start = Date.now();
  console.log('[auto-scan] Starting scheduled sync + scan');

  try {
    const users = await prisma.user.findMany({
      where: { githubToken: { not: '' } },
      select: { id: true, githubLogin: true, githubToken: true },
    });

    for (const user of users) {
      try {
        // 1. Sync repos
        const githubRepos = await getUserRepos(user.githubToken);
        const syncResult = await syncUserRepos(prisma, user.id, githubRepos);
        console.log(`[auto-scan] ${user.githubLogin}: synced ${syncResult.syncedCount} repos`);

        // 2. Hoist rateLimited above the staleness gate so CI sync can set it
        let rateLimited = false;

        // 3. Sync CI runs once per user per cycle (before staleness gate so it
        //    always runs regardless of whether dep scans are due)
        try {
          const ciSummary = await syncAllUserRepos(user.id, { daysBack: 30 });
          console.log(`[auto-scan] ${user.githubLogin}: CI sync completed (${ciSummary.reposSucceeded} repos, ${ciSummary.totalRunsIngested} runs ingested)`);
        } catch (e) {
          if (isRateLimited(e)) {
            console.warn(`[auto-scan] ${user.githubLogin}: CI sync rate limited`);
            rateLimited = true;
          } else {
            console.warn(`[auto-scan] ${user.githubLogin}: CI sync failed:`, (e as Error).message);
          }
        }

        // 4. Get tracked repos that are due: neither a scanner success
        //    (lastScannedAt, also set by manual scans) nor a cron attempt
        //    (lastScanAttemptAt) within the current interval. The gate keys off
        //    "last touched" so a failing repo is retried at the normal cadence;
        //    per-scanner staleness is a display concern (Repo.*ScannedAt).
        const staleThreshold = new Date(Date.now() - INTERVAL_MS);
        const repos = await prisma.repo.findMany({
          where: {
            userId: user.id,
            tracked: true,
            AND: [
              { OR: [{ lastScannedAt: null }, { lastScannedAt: { lt: staleThreshold } }] },
              { OR: [{ lastScanAttemptAt: null }, { lastScanAttemptAt: { lt: staleThreshold } }] },
            ],
          },
          select: { id: true, fullName: true },
        });

        // 5. Skip dep scans if nothing is stale (CI already synced above)
        if (repos.length === 0) {
          console.log(`[auto-scan] ${user.githubLogin}: all repos up to date, skipping`);
          continue;
        }

        if (rateLimited) {
          console.warn(`[auto-scan] ${user.githubLogin}: skipping dep scans, rate limited`);
          continue;
        }

        console.log(`[auto-scan] ${user.githubLogin}: scanning ${repos.length} stale repos`);

        // 6. Scan each repo (3 scans in parallel per repo)
        for (const repo of repos) {
          if (rateLimited) break;

          const results = await Promise.allSettled([
            scanRepository(user.id, repo.id, user.githubToken),
            scanLicenses(user.id, repo.id, user.githubToken),
            scanDependencies(user.id, repo.id, user.githubToken),
          ]);

          for (const r of results) {
            if (r.status === 'rejected') {
              if (isRateLimited(r.reason)) {
                console.warn(`[auto-scan] Rate limited on ${repo.fullName}, stopping user ${user.githubLogin}`);
                rateLimited = true;
              } else {
                console.warn(`[auto-scan] Scan failed for ${repo.fullName}:`, (r.reason as Error).message);
              }
            }
          }

          // Record the attempt only. Success timestamps are written by the
          // scanners themselves, so a repo whose scanners all threw does not
          // look freshly scanned.
          if (!rateLimited) {
            await prisma.repo.update({
              where: { id: repo.id },
              data: { lastScanAttemptAt: new Date() },
            });
          }
        }
      } catch (e) {
        if (isRateLimited(e)) {
          console.warn(`[auto-scan] Rate limited for user ${user.githubLogin}, skipping`);
        } else {
          console.error(`[auto-scan] Failed for user ${user.githubLogin}:`, (e as Error).message);
        }
      }
    }
  } catch (e) {
    console.error('[auto-scan] Fatal error:', (e as Error).message);
  } finally {
    running = false;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[auto-scan] Completed in ${elapsed}s. Next run in ${INTERVAL_MS / 60_000}min`);
  }
}

export function startAutoScan() {
  if (timer) return;
  console.log(`[auto-scan] Scheduling every ${INTERVAL_MS / 60_000}min (SCAN_INTERVAL_MINUTES=${process.env.SCAN_INTERVAL_MINUTES ?? '60'})`);
  timer = setInterval(() => void runAutoScan(), INTERVAL_MS);
  // Run first scan after a short delay to not block startup
  setTimeout(() => void runAutoScan(), 10_000);

  process.on('SIGTERM', () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    console.log('[auto-scan] Stopped (SIGTERM)');
  });
}
