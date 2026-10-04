// Route-level tests for GET /api/sbom.
// PATTERN B: vi.hoisted() handles, vi.mock() before imports, import route last.
// Asserts exact prisma.scan.findFirst where clause incl. ownership guard.
// The route resolves its caller through the real resolveRequestUser, so the
// Bearer dsat_ path is exercised end to end (auth + headers + apiToken lookup
// are the only stubs): a regression back to a session-only check makes the
// Bearer tests below fail.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { authMock, headersMock, apiTokenFindUnique, apiTokenUpdate, scanFindFirst, generateSBOMMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    headersMock: vi.fn(),
    apiTokenFindUnique: vi.fn(),
    apiTokenUpdate: vi.fn(),
    scanFindFirst: vi.fn(),
    generateSBOMMock: vi.fn(),
  }));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    apiToken: {
      findUnique: apiTokenFindUnique,
      update: apiTokenUpdate,
    },
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

function buildHeaders(map: Record<string, string>) {
  return { get: (k: string) => map[k.toLowerCase()] ?? null };
}

function mockBearerToken(scope: 'READ' | 'WRITE') {
  authMock.mockResolvedValue(null);
  headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_valid' }));
  apiTokenFindUnique.mockResolvedValue({
    id: 'tok-1',
    revokedAt: null,
    scope,
    user: { id: 'token-owner', githubLogin: 'agent', githubToken: 'gh_tok' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/sbom', () => {
  beforeEach(() => {
    authMock.mockReset();
    headersMock.mockReset();
    apiTokenFindUnique.mockReset();
    apiTokenUpdate.mockReset();
    scanFindFirst.mockReset();
    generateSBOMMock.mockReset();
    apiTokenUpdate.mockResolvedValue({});
    // Default: no Authorization header (browser-session tests).
    headersMock.mockResolvedValue(buildHeaders({}));
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

  it('(5) uses plain fallback filename sbom.cdx.json when bom.metadata.component is absent', async () => {
    authMock.mockResolvedValue({ user: { id: 'user-1' } });
    scanFindFirst.mockResolvedValue({ id: 'scan-1' });
    generateSBOMMock.mockResolvedValue({ metadata: {}, components: [] });

    const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

    expect(res.status).toBe(200);
    // No component name -> plain 'sbom.cdx.json', not the doubled 'sbom-sbom.cdx.json'.
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="sbom.cdx.json"');
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
  describe('Bearer dsat_ token access', () => {
    const bom = { metadata: { component: { name: 'owner/my-repo' } }, components: [] };

    it('(7) a READ-scoped token gets 200 and the SBOM is built for the token owner', async () => {
      mockBearerToken('READ');
      scanFindFirst.mockResolvedValue({ id: 'scan-1' });
      generateSBOMMock.mockResolvedValue(bom);

      const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/vnd.cyclonedx+json; version=1.4');
      expect(generateSBOMMock).toHaveBeenCalledWith('token-owner', 'repo-1');
    });

    it('(8) a WRITE-scoped token also gets 200 (read route, either scope)', async () => {
      mockBearerToken('WRITE');
      scanFindFirst.mockResolvedValue({ id: 'scan-1' });
      generateSBOMMock.mockResolvedValue(bom);

      const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

      expect(res.status).toBe(200);
    });

    it('(9) the token path keeps the ownership guard: the scan lookup is scoped to the token owner', async () => {
      mockBearerToken('READ');
      scanFindFirst.mockResolvedValue(null);

      const res = await GET(makeGetRequest({ repoId: 'someone-elses-repo' }));

      expect(res.status).toBe(404);
      expect(scanFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            repoId: 'someone-elses-repo',
            status: 'COMPLETED',
            repo: { userId: 'token-owner', tracked: true },
          },
        }),
      );
      expect(generateSBOMMock).not.toHaveBeenCalled();
    });

    it('(10) an unknown dsat_ token gets 401', async () => {
      authMock.mockResolvedValue(null);
      headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_unknown' }));
      apiTokenFindUnique.mockResolvedValue(null);

      const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

      expect(res.status).toBe(401);
      expect(scanFindFirst).not.toHaveBeenCalled();
    });

    it('(11) a revoked dsat_ token gets 401', async () => {
      authMock.mockResolvedValue(null);
      headersMock.mockResolvedValue(buildHeaders({ authorization: 'Bearer dsat_revoked' }));
      apiTokenFindUnique.mockResolvedValue({
        id: 'tok-2',
        revokedAt: new Date('2026-01-01T00:00:00Z'),
        scope: 'READ',
        user: { id: 'token-owner', githubLogin: 'agent', githubToken: 'gh_tok' },
      });

      const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

      expect(res.status).toBe(401);
      expect(scanFindFirst).not.toHaveBeenCalled();
    });

    it('(12) no session and no Authorization header gets 401 without a token lookup', async () => {
      authMock.mockResolvedValue(null);

      const res = await GET(makeGetRequest({ repoId: 'repo-1' }));

      expect(res.status).toBe(401);
      expect(apiTokenFindUnique).not.toHaveBeenCalled();
    });
  });
});
