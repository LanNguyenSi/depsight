import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { scanPRAndComment } from '@/lib/pr/pr-scanner';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pr-scan
 * Trigger a CVE scan for a specific PR and post a comment with results.
 *
 * Body: { owner: string, repo: string, prNumber: number }
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json() as {
    owner?: string;
    repo?: string;
    prNumber?: number;
  };

  const { owner, repo, prNumber } = body;

  if (!owner || !repo || !prNumber) {
    return NextResponse.json(
      { error: 'owner, repo, and prNumber are required' },
      { status: 400 },
    );
  }

  if (!Number.isInteger(prNumber) || prNumber < 1) {
    return NextResponse.json({ error: 'prNumber must be a positive integer' }, { status: 400 });
  }

  try {
    const result = await scanPRAndComment(
      session.user.githubToken,
      owner,
      repo,
      prNumber,
      session.user.id,
    );

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PR scan failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
