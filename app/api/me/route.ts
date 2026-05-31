import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// GET /api/me — the current browser user's identity for the header user menu.
// Session-only (no dsat_ bearer): this is purely a UI concern.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { githubLogin: true, avatarUrl: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({
    githubLogin: user.githubLogin,
    avatarUrl: user.avatarUrl,
  });
}
