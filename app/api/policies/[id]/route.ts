import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser, hasWriteScope } from '@/lib/auth-api';
import { getPolicyById, updatePolicy, deletePolicy } from '@/lib/policy/service';
import { validateDependencyMinVersionRule } from '@/lib/policy/engine';
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

  // A PUT can change `type` and `rule` independently, so validating a
  // DEPENDENCY_MIN_VERSION rule needs the *effective* type and rule after
  // this request applies, not just what this request happens to include.
  // Two cases need the currently stored policy:
  //   (a) this request sets only `rule`, on a policy that is ALREADY
  //       DEPENDENCY_MIN_VERSION (type omitted): validate the new rule
  //       against the stored type.
  //   (b) this request sets `type` to DEPENDENCY_MIN_VERSION without
  //       resending `rule`: validate the STORED rule, so a policy can't
  //       flip into DEPENDENCY_MIN_VERSION while carrying an incompatible
  //       rule shape left over from its previous type (which would then
  //       fail isDependencyMinVersionRule at evaluation time and report
  //       clean forever).
  // When this request sets both `type` and `rule` together, neither fetch
  // is needed: the new rule is validated directly, as before.
  const needsStoredPolicy =
    (updateData.rule !== undefined && updateData.type === undefined) ||
    (updateData.type === PolicyType.DEPENDENCY_MIN_VERSION && updateData.rule === undefined);

  let storedPolicy: Awaited<ReturnType<typeof getPolicyById>> | null = null;
  if (needsStoredPolicy) {
    storedPolicy = await getPolicyById(user.id, id);
    if (!storedPolicy) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  const effectiveType = updateData.type ?? storedPolicy?.type;
  if (effectiveType === PolicyType.DEPENDENCY_MIN_VERSION) {
    const ruleToValidate = updateData.rule ?? storedPolicy?.rule;
    const result = validateDependencyMinVersionRule(ruleToValidate);
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    // Always write the *validated* rule back into updateData, not just when
    // this request happened to send `rule` itself. Door (b) (`type` flips to
    // DEPENDENCY_MIN_VERSION, `rule` omitted) validates the STORED rule, but
    // that stored rule can still be un-normalized (padded package name from
    // whatever wrote it originally). Without this unconditional assignment,
    // updateData.rule stays undefined on that path, updatePolicy() leaves
    // the stored rule untouched, and the padded name survives — the same
    // bug validateDependencyMinVersionRule's trim was meant to close, just
    // reopened by a write path that never read its normalized return value.
    // Persisting result.rule unconditionally makes every write path for this
    // policy type route through the validated value; on the paths that
    // already sent a matching rule this is a no-op (identical to the
    // previous behavior), so nothing else changes.
    updateData.rule = result.rule as unknown as Prisma.InputJsonValue;
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
