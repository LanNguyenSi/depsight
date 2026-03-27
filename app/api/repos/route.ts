import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getUserRepos } from '@/lib/github';

export async function GET() {
  const session = await auth();

  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const githubToken = (session.user as any).githubToken;
  if (!githubToken) {
    return NextResponse.json({ error: 'No GitHub token found' }, { status: 400 });
  }

  try {
    const repos = await getUserRepos(githubToken);
    return NextResponse.json({ repos });
  } catch (error) {
    console.error('Failed to fetch repos:', error);
    return NextResponse.json({ error: 'Failed to fetch repositories' }, { status: 500 });
  }
}
