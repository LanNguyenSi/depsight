import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth-api';
import { evaluatePolicies } from '@/lib/policy/engine';
import { readJsonCapped } from '@/lib/http/read-json-capped';
import { rateLimitedResponse, policyEvaluateRateLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// POST /api/policies/evaluate — evaluate policies against a scan
export async function POST(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Keyed by user id; an unauthenticated request above has already returned
  // and does not count.
  const limit = policyEvaluateRateLimiter.check(user.id);
  if (!limit.allowed) return rateLimitedResponse(limit);

  const parsed = await readJsonCapped<{ scanId?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
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
