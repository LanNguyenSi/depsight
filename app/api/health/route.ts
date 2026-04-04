import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';

export async function GET() {
  const status: { status: string; db: string; timestamp: string; error?: string } = {
    status: 'ok',
    db: 'ok',
    timestamp: new Date().toISOString(),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    status.status = 'degraded';
    status.db = 'unreachable';
    status.error = e instanceof Error ? e.message : 'Unknown database error';
    return NextResponse.json(status, { status: 503 });
  }

  return NextResponse.json(status);
}
