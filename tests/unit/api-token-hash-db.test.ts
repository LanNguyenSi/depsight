// Deploy-path test for hashing API tokens at rest: a production database whose
// "ApiToken" rows still hold raw `dsat_...` tokens must keep authenticating them
// after the deploy, and must no longer contain them.
//
// The migration is SQL in prisma/pre-push/advisory-unique-key.sql, run by the
// same `prisma db execute --file ...` that every deploy path runs before
// `prisma db push`. Like tests/unit/advisory-dedupe-db.test.ts it needs a real
// Postgres, so the database half runs only when DEPSIGHT_TEST_DATABASE_URL points
// at a scratch server (for example postgresql://depsight:depsight@127.0.0.1:5432/depsight).
// Each case works in its own schema of that database and drops it afterwards. CI
// provides the server in the `Advisory dedupe (Postgres)` job. The wiring half
// (the SQL file carries the step) always runs.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const ROOT = resolve(__dirname, '../..');
const BASE_URL = process.env.DEPSIGHT_TEST_DATABASE_URL;
const SQL_FILE = 'prisma/pre-push/advisory-unique-key.sql';

// resolveRequestUser reads these three modules; the database one is a real client
// on the case's schema, the other two supply the request.
const { holder, headerState } = vi.hoisted(() => ({
  holder: { client: null as unknown },
  headerState: { authorization: '' },
}));
vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return holder.client;
  },
}));
vi.mock('@/lib/auth', () => ({ auth: async () => null }));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) => (k.toLowerCase() === 'authorization' ? headerState.authorization : null),
  }),
}));

import { resolveRequestUser } from '@/lib/auth-api';

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');

const RAW_WRITE = 'dsat_' + '1'.repeat(64);
const RAW_READ = 'dsat_' + '2'.repeat(64);
const RAW_REVOKED = 'dsat_' + '3'.repeat(64);
// A row written after the change: already a digest.
const RAW_NEW = 'dsat_' + '4'.repeat(64);

describe('API token hashing, wiring', () => {
  it('the pre-push SQL hashes only rows that still start with dsat_ and skips a missing table', () => {
    const sql = readFileSync(join(ROOT, SQL_FILE), 'utf8').replace(/\s+/g, ' ');
    expect(sql).toContain(`to_regclass('"ApiToken"') IS NULL`);
    expect(sql).toContain(`UPDATE "ApiToken" SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex') WHERE left("token", 5) = 'dsat_'`);
  });
});

function run(args: string[], url: string, bin = 'npx'): { ok: boolean; output: string } {
  try {
    const output = execFileSync(bin, args, {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe.skipIf(!BASE_URL)('API token hashing against Postgres', () => {
  const schemas: string[] = [];

  const urlFor = (schema: string) => {
    const u = new URL(BASE_URL as string);
    u.searchParams.set('schema', schema);
    return u.toString();
  };

  afterAll(async () => {
    const admin = new PrismaClient({ datasourceUrl: BASE_URL });
    for (const s of schemas) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    await admin.$disconnect();
  });

  function newSchema(name: string): string {
    const schema = `tokhash_${name}_${process.pid}_${Date.now()}`;
    schemas.push(schema);
    return schema;
  }

  const prePush = (url: string) =>
    run(['prisma', 'db', 'execute', '--file', SQL_FILE, '--schema', 'prisma/schema.prisma'], url);

  async function seedPlaintext(client: PrismaClient) {
    await client.$executeRawUnsafe(
      `INSERT INTO "User"(id,"githubId","githubLogin","githubToken","updatedAt") VALUES ('u1','1','octo','gh_tok',now())`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "ApiToken"(id,"userId",token,name,scope,"revokedAt","lastUsedAt") VALUES
        ('t-write','u1','${RAW_WRITE}','plain write','WRITE',NULL,now()),
        ('t-read','u1','${RAW_READ}','plain read','READ',NULL,NULL),
        ('t-revoked','u1','${RAW_REVOKED}','plain revoked','WRITE',now(),NULL),
        ('t-new','u1','${sha256Hex(RAW_NEW)}','already hashed','READ',NULL,NULL)`,
    );
  }

  const snapshot = (client: PrismaClient) =>
    client.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "ApiToken" ORDER BY id`);

  async function authenticate(raw: string) {
    headerState.authorization = `Bearer ${raw}`;
    return resolveRequestUser();
  }

  it(
    'hashes plaintext rows once, leaves everything else alone, is a no-op the second time, and old tokens still authenticate',
    async () => {
      const url = urlFor(newSchema('rows'));
      const push = run(['prisma', 'db', 'push', '--skip-generate', '--schema=prisma/schema.prisma'], url);
      expect(push.ok, push.output).toBe(true);

      const client = new PrismaClient({ datasourceUrl: url });
      holder.client = client;
      try {
        await seedPlaintext(client);
        // Before the migration the raw value is what the table holds (negative control).
        const before = await snapshot(client);
        expect(before.find((r) => r.id === 't-write')?.token).toBe(RAW_WRITE);

        const first = prePush(url);
        expect(first.ok, first.output).toBe(true);
        const after = await snapshot(client);
        const byId = Object.fromEntries(after.map((r) => [r.id as string, r]));
        expect(byId['t-write'].token).toBe(sha256Hex(RAW_WRITE));
        expect(byId['t-read'].token).toBe(sha256Hex(RAW_READ));
        expect(byId['t-revoked'].token).toBe(sha256Hex(RAW_REVOKED));
        expect(byId['t-new'].token).toBe(sha256Hex(RAW_NEW));
        // Nothing but the token column changed.
        const strip = (rows: Array<Record<string, unknown>>) =>
          rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'token')));
        expect(strip(after)).toEqual(strip(before));
        for (const row of after) expect(String(row.token)).toMatch(/^[0-9a-f]{64}$/);

        // A second deploy changes nothing at all.
        const second = prePush(url);
        expect(second.ok, second.output).toBe(true);
        expect(await snapshot(client)).toEqual(after);

        // Pre-existing tokens keep working; their scope and revocation carry over.
        expect(await authenticate(RAW_WRITE)).toMatchObject({ id: 'u1', scope: 'WRITE', githubToken: 'gh_tok' });
        expect(await authenticate(RAW_READ)).toMatchObject({ id: 'u1', scope: 'READ' });
        expect(await authenticate(RAW_NEW)).toMatchObject({ id: 'u1', scope: 'READ' });
        expect(await authenticate(RAW_REVOKED)).toBeNull();
        // The stored hash is not a credential.
        expect(await authenticate(sha256Hex(RAW_WRITE))).toBeNull();
        expect(await authenticate('dsat_' + sha256Hex(RAW_WRITE))).toBeNull();
      } finally {
        holder.client = null;
        await client.$disconnect();
      }
    },
    240_000,
  );

  it(
    'npm run db:push (the deploy order) hashes plaintext rows and keeps the schema push working',
    async () => {
      const url = urlFor(newSchema('npm'));
      const first = run(['run', 'db:push', '--', '--skip-generate'], url, 'npm');
      expect(first.ok, first.output).toBe(true);
      const client = new PrismaClient({ datasourceUrl: url });
      try {
        await seedPlaintext(client);
        const again = run(['run', 'db:push', '--', '--skip-generate'], url, 'npm');
        expect(again.ok, again.output).toBe(true);
        const rows = await client.$queryRawUnsafe<Array<{ id: string; token: string }>>(
          `SELECT id, token FROM "ApiToken" ORDER BY id`,
        );
        // ordered by id: t-new, t-read, t-revoked, t-write
        expect(rows.map((r) => r.token)).toEqual([
          sha256Hex(RAW_NEW),
          sha256Hex(RAW_READ),
          sha256Hex(RAW_REVOKED),
          sha256Hex(RAW_WRITE),
        ]);
      } finally {
        await client.$disconnect();
      }
    },
    240_000,
  );

  it(
    'the SQL step succeeds on a fresh database without an ApiToken table',
    async () => {
      const url = urlFor(newSchema('fresh'));
      const out = prePush(url);
      expect(out.ok, out.output).toBe(true);
    },
    120_000,
  );
});
