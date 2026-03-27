import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getPolicyById, updatePolicy, deletePolicy } from '@/lib/policy/service';
import { Prisma, PolicyType, Severity } from '@prisma/client';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/policies/[id]
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const policy = await getPolicyById(session.user.id, id);
  if (!policy) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ policy });
}

// PUT /api/policies/[id]
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  const policy = await updatePolicy(session.user.id, id, updateData);
  if (!policy) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ policy });
}

// DELETE /api/policies/[id]
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const deleted = await deletePolicy(session.user.id, id);
  if (!deleted) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
