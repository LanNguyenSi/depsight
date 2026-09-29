import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Python and Rust scanners store the license string they prepared
// (free-text name mapped to an SPDX id, dual-license expression reduced to its
// most permissive part), not the raw registry value. license-classifier.test.ts
// only covers the classification, so these tests pin the stored string.

const mockCollectPythonDeps = vi.fn();
const mockCollectRustDeps = vi.fn();

vi.mock('@/lib/github', () => ({
  createGitHubClient: () => ({}),
}));

vi.mock('@/lib/manifests/python', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifests/python')>();
  return {
    ...actual,
    collectPythonDeps: (...args: unknown[]) => mockCollectPythonDeps(...args),
  };
});

vi.mock('@/lib/manifests/rust', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manifests/rust')>();
  return {
    ...actual,
    collectRustDeps: (...args: unknown[]) => mockCollectRustDeps(...args),
  };
});

import { scanPythonLicenses } from '@/lib/license/python';
import { scanRustLicenses } from '@/lib/license/rust';

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  mockCollectPythonDeps.mockReset();
  mockCollectRustDeps.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scanPythonLicenses displayed license', () => {
  it('stores the SPDX id mapped from a PyPI free-text license, not the raw string', async () => {
    mockCollectPythonDeps.mockResolvedValue([{ name: 'requests', version: '2.31.0' }]);
    fetchMock.mockResolvedValue(jsonResponse({ info: { version: '2.31.0', license: 'MIT License' } }));

    const result = await scanPythonLicenses('token', 'owner', 'repo');

    expect(result).toHaveLength(1);
    expect(result[0].license).toBe('MIT');
    expect(result[0].license).not.toBe('MIT License');
    expect(result[0].isCompatible).toBe(true);
    expect(result[0].policyViolation).toBe(false);
  });

  it('stores the mapped id and the matching classification for a copyleft free-text name', async () => {
    mockCollectPythonDeps.mockResolvedValue([{ name: 'gplpkg', version: '1.0.0' }]);
    fetchMock.mockResolvedValue(
      jsonResponse({ info: { license: 'GNU General Public License v3 (GPLv3)' } }),
    );

    const result = await scanPythonLicenses('token', 'owner', 'repo');

    expect(result[0].license).toBe('GPL-3.0');
    expect(result[0].policyViolation).toBe(true);
  });
});

describe('scanRustLicenses displayed license', () => {
  it('stores the most permissive part of a dual-license expression, not the raw expression', async () => {
    mockCollectRustDeps.mockResolvedValue([{ name: 'serde', version: '1.0.0' }]);
    fetchMock.mockResolvedValue(
      jsonResponse({ versions: [{ num: '1.0.0', license: 'GPL-3.0 OR MIT', yanked: false }] }),
    );

    const result = await scanRustLicenses('token', 'owner', 'repo');

    expect(result).toHaveLength(1);
    expect(result[0].license).toBe('MIT');
    expect(result[0].license).not.toBe('GPL-3.0 OR MIT');
    expect(result[0].isCompatible).toBe(true);
    expect(result[0].policyViolation).toBe(false);
  });

  it('stores a single-license crate value unchanged', async () => {
    mockCollectRustDeps.mockResolvedValue([{ name: 'tokio', version: '1.0.0' }]);
    fetchMock.mockResolvedValue(
      jsonResponse({ versions: [{ num: '1.0.0', license: 'Apache-2.0', yanked: false }] }),
    );

    const result = await scanRustLicenses('token', 'owner', 'repo');

    expect(result[0].license).toBe('Apache-2.0');
  });
});
