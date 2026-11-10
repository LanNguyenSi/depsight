import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';

export async function GET() {
  const status: { status: string; db: string; timestamp: string } = {
    status: 'ok',
    db: 'ok',
    timestamp: new Date().toISOString(),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    status.status = 'degraded';
    status.db = 'unreachable';
    // The driver message can carry the database host and port; this route is
    // public, so it goes to the server log and never into the body.
    console.error('[health] database check failed:', e instanceof Error ? e.message : 'Unknown database error');
    return NextResponse.json(status, { status: 503 });
  }

  return NextResponse.json(status);
}
