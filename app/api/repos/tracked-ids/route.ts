import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth-api';
import { getTrackedRepoIds } from '@/lib/repos/tracked-ids';
import { serverError } from '@/lib/http/server-error';

export const dynamic = 'force-dynamic';

// GET /api/repos/tracked-ids: cheap per-tracked-repo id pair (depsight's
// own repoId beside GitHub's numeric id). No team-health computation: this
// never calls getTeamHealthOverview (lib/overview/team-health.ts). Used by
// the MCP list tool's repoId merge in place of the full /api/overview.
export async function GET() {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const repos = await getTrackedRepoIds(user.id);
    return NextResponse.json({ repos });
  } catch (error) {
    return serverError('repos/tracked-ids', 'Failed to load tracked repo ids', error);
  }
}
