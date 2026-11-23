import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser, hasWriteScope } from '@/lib/auth-api';
import { listPolicies, createPolicy, countPolicies } from '@/lib/policy/service';
import { validatePolicyRule } from '@/lib/policy/engine';
import { PolicyType, Severity } from '@prisma/client';
import { readJsonCapped } from '@/lib/http/read-json-capped';
import { rateLimitedResponse, policyCreateRateLimiter, MAX_POLICIES_PER_USER } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Policy CRUD is intentionally reachable via a dsat_ Bearer token
// (resolveRequestUser(), not auth()) on every method, including the write
// operation POST: headless agents need to create and manage policies without a
// browser session. The MCP server does not use this yet: its policy tools only
// list and evaluate policies (TODO: create/update/delete tools, if wanted). A dsat_ token carries the same
// authority as the user it belongs to, so this only widens what an
// already-valid token can do, not who can act.
//
// The write operation (POST) additionally requires the WRITE scope: a
// READ-scoped dsat_ token can list policies but not create one, so a leaked
// read-only token cannot touch the policies that gate CI decisions.

// GET /api/policies — list user's policies
export async function GET() {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const policies = await listPolicies(user.id);
  return NextResponse.json({ policies });
}

// POST /api/policies — create a new policy
export async function POST(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasWriteScope(user)) {
    return NextResponse.json({ error: 'This token does not have write access' }, { status: 403 });
  }
  // Keyed by user id; a 401 or 403 above has already returned and does not count.
  const limit = policyCreateRateLimiter.check(user.id);
  if (!limit.allowed) return rateLimitedResponse(limit);

  const parsed = await readJsonCapped<{
    name?: unknown;
    type?: unknown;
    rule?: unknown;
    severity?: unknown;
    enabled?: unknown;
  }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const { name, type, rule, severity, enabled } = body;

  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  if (!Object.values(PolicyType).includes(type as PolicyType)) {
    return NextResponse.json({ error: 'invalid type' }, { status: 400 });
  }
  if (!Object.values(Severity).includes(severity as Severity)) {
    return NextResponse.json({ error: 'invalid severity' }, { status: 400 });
  }
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    return NextResponse.json({ error: 'rule must be an object' }, { status: 400 });
  }

  const validated = validatePolicyRule(type as PolicyType, rule);
  if (validated.error !== undefined) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const ruleToPersist = validated.rule;

  // Count-then-create without a transaction: concurrent creates can overshoot
  // the cap by the in-flight requests the rate limit above allows.
  if ((await countPolicies(user.id)) >= MAX_POLICIES_PER_USER) {
    return NextResponse.json(
      { error: `A user can have at most ${MAX_POLICIES_PER_USER} policies` },
      { status: 409 },
    );
  }

  const policy = await createPolicy(user.id, {
    name: name.trim(),
    type: type as PolicyType,
    rule: ruleToPersist,
    severity: severity as Severity,
    enabled: typeof enabled === 'boolean' ? enabled : true,
  });

  return NextResponse.json({ policy }, { status: 201 });
}
