import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser, hasWriteScope } from '@/lib/auth-api';
import { getPolicyById, updatePolicy, deletePolicy } from '@/lib/policy/service';
import { validatePolicyRule } from '@/lib/policy/engine';
import { Prisma, PolicyType, Severity } from '@prisma/client';

export const dynamic = 'force-dynamic';

// Policy CRUD is intentionally reachable via a dsat_ Bearer token
// (resolveRequestUser(), not auth()) on every method, including the write
// operations PUT/DELETE: headless agents such as the MCP server need to
// manage policies without a browser session. A dsat_ token carries the
// same authority as the user it belongs to, so this only widens what an
// already-valid token can do, not who can act.
//
// The write operations (PUT/DELETE) additionally require the WRITE scope:
// a READ-scoped dsat_ token can fetch a single policy but not modify or
// remove one, so a leaked read-only token cannot touch the policies that
// gate CI decisions.

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/policies/[id]
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const policy = await getPolicyById(user.id, id);
  if (!policy) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ policy });
}

// PUT /api/policies/[id]
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasWriteScope(user)) {
    return NextResponse.json({ error: 'This token does not have write access' }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json() as {
    name?: unknown;
    type?: unknown;
    rule?: unknown;
    severity?: unknown;
    enabled?: unknown;
  };

  const updateData: {
    name?: string;
    type?: PolicyType;
    rule?: Prisma.InputJsonValue;
    severity?: Severity;
    enabled?: boolean;
  } = {};

  if (typeof body.name === 'string' && body.name.trim()) {
    updateData.name = body.name.trim();
  }
  if (body.type !== undefined) {
    if (!Object.values(PolicyType).includes(body.type as PolicyType)) {
      return NextResponse.json({ error: 'invalid type' }, { status: 400 });
    }
    updateData.type = body.type as PolicyType;
  }
  if (body.severity !== undefined) {
    if (!Object.values(Severity).includes(body.severity as Severity)) {
      return NextResponse.json({ error: 'invalid severity' }, { status: 400 });
    }
    updateData.severity = body.severity as Severity;
  }
  if (body.rule !== undefined) {
    if (typeof body.rule !== 'object' || body.rule === null || Array.isArray(body.rule)) {
      return NextResponse.json({ error: 'rule must be an object' }, { status: 400 });
    }
    updateData.rule = body.rule as Prisma.InputJsonValue;
  }
  if (typeof body.enabled === 'boolean') {
    updateData.enabled = body.enabled;
  }

  // A PUT can change `type` and `rule` independently, so validating the rule
  // needs the *effective* type and rule after this request applies, not just
  // what this request happens to include. When this request sets only `rule`,
  // it is validated against the stored type; when it sets only `type`, the
  // STORED rule is validated against the new type, so a policy cannot flip
  // type while carrying a rule shape left over from its previous type (which
  // would fail its guard at evaluation time and report clean forever). When it
  // sets both, neither fetch is needed. A request touching neither field
  // (name, severity, enabled only) leaves the stored rule alone.
  const changesRuleOrType = updateData.rule !== undefined || updateData.type !== undefined;
  if (changesRuleOrType) {
    let storedPolicy: Awaited<ReturnType<typeof getPolicyById>> | null = null;
    if (updateData.rule === undefined || updateData.type === undefined) {
      storedPolicy = await getPolicyById(user.id, id);
      if (!storedPolicy) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }

    const effectiveType = (updateData.type ?? storedPolicy?.type) as PolicyType;
    const ruleToValidate = updateData.rule ?? storedPolicy?.rule;
    const result = validatePolicyRule(effectiveType, ruleToValidate);
    if (result.error !== undefined) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    // Always write the *validated* rule back, not just when this request sent
    // `rule` itself: DEPENDENCY_MIN_VERSION normalizes the package name, and a
    // type flip validates the STORED rule, which can still be un-normalized.
    // Persisting result.rule makes every write path route through the
    // validated value.
    updateData.rule = result.rule;
  }

  const policy = await updatePolicy(user.id, id, updateData);
  if (!policy) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ policy });
}

// DELETE /api/policies/[id]
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasWriteScope(user)) {
    return NextResponse.json({ error: 'This token does not have write access' }, { status: 403 });
  }

  const { id } = await params;
  const deleted = await deletePolicy(user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
