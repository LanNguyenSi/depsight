import { prisma } from '@/lib/prisma';
import { getUserRepos } from '@/lib/github';
import { syncUserRepos } from '@/lib/repos/sync';
import { scanRepository } from '@/lib/cve/scanner';
import { scanLicenses } from '@/lib/license/scanner';
import { scanDependencies } from '@/lib/deps/scanner';

const INTERVAL_MS = (parseInt(process.env.SCAN_INTERVAL_MINUTES ?? '60', 10) || 60) * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

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

        // 2. Get tracked repos
        const repos = await prisma.repo.findMany({
          where: { userId: user.id, tracked: true },
          select: { id: true, fullName: true },
        });

        // 3. Scan each repo
        for (const repo of repos) {
          try {
            await scanRepository(user.id, repo.id, user.githubToken);
          } catch (e) {
            console.warn(`[auto-scan] CVE scan failed for ${repo.fullName}:`, (e as Error).message);
          }
          try {
            await scanLicenses(user.id, repo.id, user.githubToken);
          } catch (e) {
            console.warn(`[auto-scan] License scan failed for ${repo.fullName}:`, (e as Error).message);
          }
          try {
            await scanDependencies(user.id, repo.id, user.githubToken);
          } catch (e) {
            console.warn(`[auto-scan] Deps scan failed for ${repo.fullName}:`, (e as Error).message);
          }
        }
      } catch (e) {
        console.error(`[auto-scan] Failed for user ${user.githubLogin}:`, (e as Error).message);
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
}
