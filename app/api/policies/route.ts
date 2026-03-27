import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listPolicies, createPolicy } from '@/lib/policy/service';
import { Prisma, PolicyType, Severity } from '@prisma/client';

export const dynamic = 'force-dynamic';

// GET /api/policies — list user's policies
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const policies = await listPolicies(session.user.id);
  return NextResponse.json({ policies });
}

// POST /api/policies — create a new policy
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
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

  const policy = await createPolicy(session.user.id, {
    name: name.trim(),
    type: type as PolicyType,
    rule: rule as Prisma.InputJsonValue,
    severity: severity as Severity,
    enabled: typeof enabled === 'boolean' ? enabled : true,
  });

  return NextResponse.json({ policy }, { status: 201 });
}
