import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth-api';
import { getUserRepos } from '@/lib/github';
import { rateLimitedResponse, reposRateLimiter } from '@/lib/rate-limit';
import { serverError } from '@/lib/http/server-error';

export async function GET(req: NextRequest) {
  const user = await resolveRequestUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = reposRateLimiter.check(user.id);
  if (!limit.allowed) {
    return rateLimitedResponse(limit);
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
    return serverError('repos', 'Failed to fetch repositories', error);
  }
}
