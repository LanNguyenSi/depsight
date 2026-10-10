import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUser, hasWriteScope } from '@/lib/auth-api';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const STATUSES = ['ACKNOWLEDGED', 'IGNORED'] as const;
type Status = (typeof STATUSES)[number];

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_NOTE_LENGTH = 500;

interface Target {
  repoId: string;
  ghsaId: string;
  packageName: string;
}

function parseIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IDENTIFIER_LENGTH) return null;
  return trimmed;
}

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseTarget(body: Record<string, unknown>): Target | null {
  const repoId = parseIdentifier(body.repoId);
  const ghsaId = parseIdentifier(body.ghsaId);
  const packageName = parseIdentifier(body.packageName);
  if (!repoId || !ghsaId || !packageName) return null;
  return { repoId, ghsaId, packageName };
}

// PUT /api/advisory-state: acknowledge or ignore one finding of a repository.
// Body: { repoId, ghsaId, packageName, status: 'ACKNOWLEDGED' | 'IGNORED', note? }.
// The finding is identified by advisory id + package, the same identity the
// scanner dedupes on, so the decision outlives the scan that showed it.
// Counts and risk scores are not changed by it. Requires the WRITE scope.
export async function PUT(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasWriteScope(user)) {
    return NextResponse.json({ error: 'This token does not have write access' }, { status: 403 });
  }

  const body = await readBody(req);
  const target = body ? parseTarget(body) : null;
  if (!body || !target) {
    return NextResponse.json(
      { error: 'repoId, ghsaId and packageName are required' },
      { status: 400 },
    );
  }

  const status = body.status;
  if (typeof status !== 'string' || !STATUSES.includes(status as Status)) {
    return NextResponse.json(
      { error: 'status must be ACKNOWLEDGED or IGNORED' },
      { status: 400 },
    );
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > MAX_NOTE_LENGTH) {
      return NextResponse.json(
        { error: `note must be a string of at most ${MAX_NOTE_LENGTH} characters` },
        { status: 400 },
      );
    }
    note = body.note.trim() || null;
  }

  // Ownership first: a repository of another user answers like a missing one.
  const repo = await prisma.repo.findFirst({
    where: { id: target.repoId, userId: user.id, tracked: true },
    select: { id: true },
  });
  if (!repo) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  // Only a finding some scan of this repository actually reported can be triaged.
  const known = await prisma.advisory.findFirst({
    where: { ghsaId: target.ghsaId, packageName: target.packageName, scan: { repoId: repo.id } },
    select: { id: true },
  });
  if (!known) {
    return NextResponse.json({ error: 'Advisory not found' }, { status: 404 });
  }

  const key = {
    repoId_ghsaId_packageName: {
      repoId: repo.id,
      ghsaId: target.ghsaId,
      packageName: target.packageName,
    },
  };
  const saved = await prisma.advisoryState.upsert({
    where: key,
    create: {
      repoId: repo.id,
      ghsaId: target.ghsaId,
      packageName: target.packageName,
      status: status as Status,
      note,
      setByUserId: user.id,
    },
    update: { status: status as Status, note, setByUserId: user.id },
  });

  return NextResponse.json({
    state: {
      ghsaId: saved.ghsaId,
      packageName: saved.packageName,
      status: saved.status,
      note: saved.note,
      setBy: user.githubLogin,
      setAt: saved.updatedAt,
    },
  });
}

// DELETE /api/advisory-state: clear the state of one finding (it is open again).
// Body: { repoId, ghsaId, packageName }. Idempotent: clearing a finding that has
// no state answers 200 with cleared: false. Requires the WRITE scope.
export async function DELETE(req: NextRequest) {
  const user = await resolveRequestUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasWriteScope(user)) {
    return NextResponse.json({ error: 'This token does not have write access' }, { status: 403 });
  }

  const body = await readBody(req);
  const target = body ? parseTarget(body) : null;
  if (!target) {
    return NextResponse.json(
      { error: 'repoId, ghsaId and packageName are required' },
      { status: 400 },
    );
  }

  const repo = await prisma.repo.findFirst({
    where: { id: target.repoId, userId: user.id, tracked: true },
    select: { id: true },
  });
  if (!repo) {
    return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  }

  const result = await prisma.advisoryState.deleteMany({
    where: { repoId: repo.id, ghsaId: target.ghsaId, packageName: target.packageName },
  });
  return NextResponse.json({ success: true, cleared: result.count > 0 });
}
