// Unit tests for scripts/mint-api-token.ts (parseArgs + main()).
// PATTERN B: hoisted mock handles, vi.mock() before imports.
//
// The script's `require.main === module` guard keeps `main()` from
// auto-running when imported here; process.exit is stubbed to throw so a
// call to it halts execution instead of killing the test worker.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const { userFindUnique, apiTokenCreate } = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  apiTokenCreate: vi.fn(),
}));

class FakeProcessExit extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
// Mocked via the '@/lib/prisma' id — this resolves to the same file as the
// script's relative '../lib/prisma' import, so the mock applies there too.
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    apiToken: { create: apiTokenCreate },
    $disconnect: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import { parseArgs, main } from '../../scripts/mint-api-token';

const ORIGINAL_ARGV = process.argv;

beforeEach(() => {
  userFindUnique.mockReset();
  apiTokenCreate.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new FakeProcessExit(code);
  }) as never);
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  it('parses --user and --name long flags', () => {
    process.argv = ['node', 'mint-api-token.ts', '--user', 'user-1', '--name', 'ci-bot'];

    expect(parseArgs()).toEqual({ userId: 'user-1', name: 'ci-bot' });
  });

  it('parses -u and -n short flags', () => {
    process.argv = ['node', 'mint-api-token.ts', '-u', 'user-2', '-n', 'agent'];

    expect(parseArgs()).toEqual({ userId: 'user-2', name: 'agent' });
  });

  it('returns {} when no recognized flags are present', () => {
    process.argv = ['node', 'mint-api-token.ts'];

    expect(parseArgs()).toEqual({});
  });
});

describe('main — argument-parse edge (missing required --user)', () => {
  it('prints usage and exits with code 2, without touching prisma', async () => {
    process.argv = ['node', 'mint-api-token.ts'];

    await expect(main()).rejects.toThrow('process.exit(2)');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });
});

describe('main — user-not-found edge', () => {
  it('exits with code 1 and does not mint a token when the user does not exist', async () => {
    process.argv = ['node', 'mint-api-token.ts', '--user', 'missing-user'];
    userFindUnique.mockResolvedValue(null);

    await expect(main()).rejects.toThrow('process.exit(1)');

    expect(userFindUnique).toHaveBeenCalledWith({
      where: { id: 'missing-user' },
      select: { id: true, githubLogin: true },
    });
    expect(console.error).toHaveBeenCalledWith('User not found: missing-user');
    expect(apiTokenCreate).not.toHaveBeenCalled();
  });
});

describe('main — success path', () => {
  it('mints a token: prisma.apiToken.create called with userId, a dsat_-prefixed token, and the given --name label', async () => {
    process.argv = ['node', 'mint-api-token.ts', '--user', 'user-1', '--name', 'headless-agent'];
    userFindUnique.mockResolvedValue({ id: 'user-1', githubLogin: 'acme' });
    apiTokenCreate.mockResolvedValue({ id: 'token-db-1', name: 'headless-agent', createdAt: new Date('2026-07-01T00:00:00Z') });

    await main();

    expect(apiTokenCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        token: expect.stringMatching(/^dsat_[0-9a-f]{64}$/),
        name: 'headless-agent',
      },
      select: { id: true, name: true, createdAt: true },
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('dsat_'));
  });

  it('derives a default cli-<date> label when --name is omitted', async () => {
    process.argv = ['node', 'mint-api-token.ts', '--user', 'user-1'];
    userFindUnique.mockResolvedValue({ id: 'user-1', githubLogin: 'acme' });
    apiTokenCreate.mockResolvedValue({ id: 'token-db-2', name: 'cli-2026-07-01', createdAt: new Date('2026-07-01T00:00:00Z') });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T08:00:00Z'));

    await main();

    expect(apiTokenCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        token: expect.stringMatching(/^dsat_[0-9a-f]{64}$/),
        name: 'cli-2026-07-01',
      },
      select: { id: true, name: true, createdAt: true },
    });

    vi.useRealTimers();
  });
});
