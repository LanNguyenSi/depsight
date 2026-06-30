// Route-level tests for GET /api/sbom.
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import route last.
// Asserts exact prisma.scan.findFirst where clause incl. ownership guard.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, scanFindFirst, generateSBOMMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  scanFindFirst: vi.fn(),
  generateSBOMMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    scan: {
      findFirst: scanFindFirst,
    },
  },
}));
vi.mock('@/lib/sbom/cyclonedx', () => ({
  generateSBOM: generateSBOMMock,
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { GET } from '@/app/api/sbom/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeGetRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/sbom');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/sbom', () => {
  beforeEach(() => {
    authMock.mockReset();
    scanFindFirst.mockReset();
    generateSBOMMock.mockReset();
  });

  it('(1) returns 401 when auth returns no session', async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(scanFindFirst).not.toHaveBeenCalled();
  });

  it('(2) returns 400 when repoId query param is absent', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('repoId is required');
    expect(scanFindFirst).not.toHaveBeenCalled();
  });

  it('(3) returns 404 with error:no_scan when no completed scan exists for the repo', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-7' } });
    scanFindFirst.mockResolvedValue(null);

    const res = await GET(makeGetRequest({ repoId: 'repo-abc' }));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('no_scan');
    // Assert exact where clause including ownership / tracked guard
    expect(scanFindFirst).toHaveBeenCalledWith({
      where: {
        repoId: 'repo-abc',
        status: 'COMPLETED',
        repo: { userId: 'user-7', tracked: true },
      },
      orderBy: { scannedAt: 'desc' },
      select: { id: true },
    });
  });

  it('(4) returns 200 with CycloneDX content-type and filename derived from bom.metadata.component.name', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    scanFindFirst.mockResolvedValue({ id: 'scan-1' });
    const bom = {
      metadata: { component: { name: 'owner/my-repo' } },
      components: [],
    };
    generateSBOMMock.mockResolvedValue(bom);

    const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.cyclonedx+json; version=1.4');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="owner-my-repo-sbom.cdx.json"');
    expect(generateSBOMMock).toHaveBeenCalledWith('user-1', 'repo-1');
    // Body should be parseable JSON matching the bom
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ metadata: { component: { name: 'owner/my-repo' } } });
  });

  it('(5) uses fallback filename sbom when bom.metadata.component is absent', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    scanFindFirst.mockResolvedValue({ id: 'scan-1' });
    generateSBOMMock.mockResolvedValue({ metadata: {}, components: [] });

    const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="sbom-sbom.cdx.json"');
  });

  it('(6) returns 500 when generateSBOM throws', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    scanFindFirst.mockResolvedValue({ id: 'scan-1' });
    generateSBOMMock.mockRejectedValue(new Error('SBOM build failed'));

    const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('SBOM build failed');
  });
});
