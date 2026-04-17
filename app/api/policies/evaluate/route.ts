import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth-api';
import { evaluatePolicies } from '@/lib/policy/engine';

export const dynamic = 'force-dynamic';

// POST /api/policies/evaluate — evaluate policies against a scan
export async function POST(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json() as { scanId?: unknown };
  const { scanId } = body;

  if (typeof scanId !== 'string' || !scanId.trim()) {
    return NextResponse.json({ error: 'scanId is required' }, { status: 400 });
  }

  try {
    const violations = await evaluatePolicies(user.id, scanId.trim());
    return NextResponse.json({ violations, count: violations.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Evaluation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
