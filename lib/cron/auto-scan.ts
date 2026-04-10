import { prisma } from '@/lib/prisma';
import { getUserRepos } from '@/lib/github';
import { syncUserRepos } from '@/lib/repos/sync';
import { scanRepository } from '@/lib/cve/scanner';
import { scanLicenses } from '@/lib/license/scanner';
import { scanDependencies } from '@/lib/deps/scanner';

const INTERVAL_MS = (parseInt(process.env.SCAN_INTERVAL_MINUTES ?? '60', 10) || 60) * 60_000;

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

        // 2. Get tracked repos not scanned within the current interval
        const staleThreshold = new Date(Date.now() - INTERVAL_MS);
        const repos = await prisma.repo.findMany({
          where: {
            userId: user.id,
            tracked: true,
            OR: [
              { lastScannedAt: null },
              { lastScannedAt: { lt: staleThreshold } },
            ],
          },
          select: { id: true, fullName: true },
        });

        if (repos.length === 0) {
          console.log(`[auto-scan] ${user.githubLogin}: all repos up to date, skipping`);
          continue;
        }

        console.log(`[auto-scan] ${user.githubLogin}: scanning ${repos.length} stale repos`);

        // 3. Scan each repo (3 scans in parallel per repo)
        let rateLimited = false;
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

          if (!rateLimited) {
            await prisma.repo.update({
              where: { id: repo.id },
              data: { lastScannedAt: new Date() },
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
