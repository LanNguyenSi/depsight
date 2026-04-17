import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth-api';
import { getAllCIHealthSummaries } from '@/lib/ci/analytics/cross-repo';
import type { Period } from '@/lib/ci/analytics/fail-rate';

export const dynamic = 'force-dynamic';

// GET /api/ci/analytics/cross-repo?period=30
export async function GET(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const periodParam = parseInt(searchParams.get('period') ?? '30');
  const period: Period = ([1, 7, 30].includes(periodParam) ? periodParam : 30) as Period;

  const summaries = await getAllCIHealthSummaries(user.id, period);
  return NextResponse.json({ period, summaries });
}
