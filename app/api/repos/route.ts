import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth-api';
import { getUserRepos } from '@/lib/github';

export async function GET(req: NextRequest) {
  const user = await resolveRequestUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!user.githubToken) {
    return NextResponse.json({ error: 'No GitHub token found' }, { status: 400 });
  }

  try {
    const allRepos = await getUserRepos(user.githubToken);
    const includeArchived = req.nextUrl.searchParams.get('includeArchived') === 'true';
    const repos = includeArchived ? allRepos : allRepos.filter((repo) => !repo.archived);
    return NextResponse.json({ repos });
  } catch (error) {
    console.error('Failed to fetch repos:', error);
    return NextResponse.json({ error: 'Failed to fetch repositories' }, { status: 500 });
  }
}
