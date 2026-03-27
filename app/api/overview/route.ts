import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getTeamHealthOverview } from '@/lib/overview/team-health';

export const dynamic = 'force-dynamic';

// GET /api/overview — team health overview across all repos
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const overview = await getTeamHealthOverview(session.user.id);
    return NextResponse.json(overview);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load overview';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
