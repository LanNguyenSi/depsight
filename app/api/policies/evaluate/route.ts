import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { evaluatePolicies } from '@/lib/policy/engine';

export const dynamic = 'force-dynamic';

// POST /api/policies/evaluate — evaluate policies against a scan
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json() as { scanId?: unknown };
  const { scanId } = body;

  if (typeof scanId !== 'string' || !scanId.trim()) {
    return NextResponse.json({ error: 'scanId is required' }, { status: 400 });
  }

  try {
    const violations = await evaluatePolicies(session.user.id, scanId.trim());
    return NextResponse.json({ violations, count: violations.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Evaluation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
