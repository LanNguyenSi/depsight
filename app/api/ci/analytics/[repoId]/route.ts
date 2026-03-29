import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getWorkflowFailRates } from '@/lib/ci/analytics/fail-rate';
import { getWorkflowBuildTimes } from '@/lib/ci/analytics/build-times';
import { detectFlakyJobs } from '@/lib/ci/analytics/flaky';
import { getBottlenecks } from '@/lib/ci/analytics/bottleneck';
import type { Period } from '@/lib/ci/analytics/fail-rate';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ repoId: string }>;
}

// GET /api/ci/analytics/[repoId]?period=7&type=fail-rate|build-times|flaky|bottleneck
export async function GET(req: NextRequest, { params }: Props) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { repoId } = await params;
  const { searchParams } = new URL(req.url);
  const periodParam = parseInt(searchParams.get('period') ?? '30');
  const period: Period = ([1, 7, 30].includes(periodParam) ? periodParam : 30) as Period;
  const type = searchParams.get('type') ?? 'fail-rate';

  // Verify ownership
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId: session.user.id },
    select: { fullName: true },
  });
  if (!repo) {
    return NextResponse.json({ error: 'Repo not found' }, { status: 404 });
  }

  const fullName = repo.fullName;

  try {
    switch (type) {
      case 'fail-rate': {
        const data = await getWorkflowFailRates(fullName, period);
        return NextResponse.json({ type, period, data });
      }
      case 'build-times': {
        const data = await getWorkflowBuildTimes(fullName, period);
        return NextResponse.json({ type, period, data });
      }
      case 'flaky': {
        const data = await detectFlakyJobs(fullName, { period });
        return NextResponse.json({ type, period, data });
      }
      case 'bottleneck': {
        const data = await getBottlenecks(fullName, period);
        return NextResponse.json({ type, period, data });
      }
      default:
        return NextResponse.json({ error: `Unknown type: ${type}` }, { status: 400 });
    }
  } catch (err) {
    console.error(`[ci/analytics] Error fetching ${type}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Analytics failed' },
      { status: 500 }
    );
  }
}
