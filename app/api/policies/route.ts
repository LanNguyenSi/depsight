import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/auth-api';
import { listPolicies, createPolicy } from '@/lib/policy/service';
import { validateDependencyMinVersionRule } from '@/lib/policy/engine';
import { Prisma, PolicyType, Severity } from '@prisma/client';

export const dynamic = 'force-dynamic';

// Policy CRUD is intentionally reachable via a dsat_ Bearer token
// (resolveRequestUser(), not auth()) on every method, including the write
// operation POST: headless agents such as the MCP server need to create and
// manage policies without a browser session. A dsat_ token carries the same
// authority as the user it belongs to, so this only widens what an
// already-valid token can do, not who can act.

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

  const body = await req.json() as {
    name?: unknown;
    type?: unknown;
    rule?: unknown;
    severity?: unknown;
    enabled?: unknown;
  };

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
  if (type === PolicyType.DEPENDENCY_MIN_VERSION) {
    const ruleError = validateDependencyMinVersionRule(rule);
    if (ruleError) {
      return NextResponse.json({ error: ruleError }, { status: 400 });
    }
  }

  const policy = await createPolicy(user.id, {
    name: name.trim(),
    type: type as PolicyType,
    rule: rule as Prisma.InputJsonValue,
    severity: severity as Severity,
    enabled: typeof enabled === 'boolean' ? enabled : true,
  });

  return NextResponse.json({ policy }, { status: 201 });
}
