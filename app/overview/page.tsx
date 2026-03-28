export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getTeamHealthOverview } from '@/lib/overview/team-health';
import { OverviewClient } from './OverviewClient';

export default async function OverviewPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const overview = await getTeamHealthOverview(session.user.id);

  const serialized = {
    repos: overview.repos.map((r) => ({
      ...r,
      lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
    })),
    aggregate: overview.aggregate,
    topRiskyRepos: overview.topRiskyRepos.map((r) => ({
      ...r,
      lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
    })),
    mostOutdated: overview.mostOutdated.map((r) => ({
      ...r,
      lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
    })),
  };

  return <OverviewClient data={serialized} />;
}
