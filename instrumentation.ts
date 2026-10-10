export async function register() {
  // Only run on the server, not during build or in edge runtime
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startAutoScan } = await import('@/lib/cron/auto-scan');
      startAutoScan();
    } catch (e) {
      // A startup configuration error (for example an invalid
      // SCAN_INTERVAL_MINUTES) must stop the process. Rethrowing leaves the
      // Next.js server up and answering 500, so a container restart policy
      // never sees a failure. Exit non-zero so the runtime does.
      console.error('[startup] Fatal configuration error, exiting:', (e as Error).message);
      process.exit(1);
    }
  }
}
