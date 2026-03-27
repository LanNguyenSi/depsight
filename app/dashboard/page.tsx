export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { DashboardClient } from './DashboardClient';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const repos = await prisma.repo.findMany({
    where: { userId: session.user.id, tracked: true },
    orderBy: { updatedAt: 'desc' },
    include: {
      scans: {
        orderBy: { scannedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          scannedAt: true,
          status: true,
          riskScore: true,
          cveCount: true,
          criticalCount: true,
          highCount: true,
          mediumCount: true,
          lowCount: true,
        },
      },
    },
  });

  return (
    <DashboardClient
      repos={repos.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        owner: r.owner,
        name: r.name,
        private: r.private,
        language: r.language,
        lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
        latestScan: r.scans[0]
          ? {
              id: r.scans[0].id,
              scannedAt: r.scans[0].scannedAt.toISOString(),
              status: r.scans[0].status,
              riskScore: r.scans[0].riskScore,
              counts: {
                total: r.scans[0].cveCount,
                critical: r.scans[0].criticalCount,
                high: r.scans[0].highCount,
                medium: r.scans[0].mediumCount,
                low: r.scans[0].lowCount,
              },
            }
          : null,
      }))}
    />
  );
}
