// Deploy-path test for the Advisory unique key: a production database that
// already holds duplicate advisory rows must survive the deploy's schema push.
//
// The database half needs a real Postgres (the migration is SQL plus
// `prisma db push`, nothing a mock can stand in for), so it runs only when
// DEPSIGHT_TEST_DATABASE_URL points at a scratch server, for example
// postgresql://depsight:depsight@127.0.0.1:5432/depsight. Each case works in
// its own schema of that database and drops it afterwards. CI provides the
// server in the `Advisory dedupe (Postgres)` job. The wiring half (the
// db:push script runs the dedupe first) always runs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const ROOT = resolve(__dirname, '../..');
const BASE_URL = process.env.DEPSIGHT_TEST_DATABASE_URL;
const UNIQUE_LINE = '@@unique([scanId, ghsaId, packageName])';

describe('db:push wiring', () => {
  it('runs the advisory dedupe before prisma db push', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:push']).toMatch(/^npm run db:dedupe && prisma db push/);
    expect(pkg.scripts['db:dedupe']).toContain('prisma/pre-push/dedupe-advisories.sql');
  });

  it('the schema carries the unique key the dedupe exists for', () => {
    const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
    expect(schema).toContain(UNIQUE_LINE);
  });
});

function run(args: string[], url: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync('npx', args, {
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

describe.skipIf(!BASE_URL)('advisory dedupe on a database with duplicates', () => {
  const schemas: string[] = [];
  let workDir = '';
  let legacySchemaPath = '';

  const urlFor = (schema: string) => {
    const u = new URL(BASE_URL as string);
    u.searchParams.set('schema', schema);
    return u.toString();
  };

  beforeAll(() => {
    // The schema as it was before the unique key: today's schema minus that line.
    const current = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
    expect(current).toContain(UNIQUE_LINE);
    workDir = mkdtempSync(join(tmpdir(), 'depsight-dedupe-'));
    legacySchemaPath = join(workDir, 'legacy.prisma');
    writeFileSync(legacySchemaPath, current.replace(UNIQUE_LINE, ''));
  });

  afterAll(async () => {
    const admin = new PrismaClient({ datasourceUrl: BASE_URL });
    for (const s of schemas) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    await admin.$disconnect();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  function newSchema(name: string): string {
    const schema = `dedupe_${name}_${process.pid}_${Date.now()}`;
    schemas.push(schema);
    return schema;
  }

  async function seedLegacy(client: PrismaClient) {
    await client.$executeRawUnsafe(
      `INSERT INTO "User"(id,"githubId","githubLogin","githubToken","updatedAt") VALUES ('u1','1','octo','tok',now())`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Repo"(id,"userId","githubId",owner,name,"fullName","updatedAt")
       VALUES ('r1','u1',1,'octo','mono','octo/mono',now()), ('r2','u1',2,'octo','solo','octo/solo',now())`,
    );
    // s1: monorepo scan, Dependabot raised the lodash alert once per manifest.
    //     Scan counts were computed from the duplicated list (7 rows).
    // s2: same advisory in a later scan of the same repo (not a duplicate of s1).
    // s3: clean scan with no duplicates (must stay byte-for-byte untouched).
    await client.$executeRawUnsafe(
      `INSERT INTO "Scan"(id,"repoId",status,"cveCount","criticalCount","highCount","mediumCount","lowCount","riskScore")
       VALUES ('s1','r1','COMPLETED',7,3,2,1,0,42),
              ('s2','r1','COMPLETED',1,1,0,0,0,10),
              ('s3','r2','COMPLETED',2,0,1,0,1,5)`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Advisory"(id,"scanId","ghsaId","cveId",source,severity,summary,"packageName",ecosystem,"vulnerableRange","fixedVersion","publishedAt") VALUES
        ('a01','s1','GHSA-aaaa','CVE-1','dependabot','CRITICAL','proto','lodash','npm',NULL,NULL,NULL),
        ('a02','s1','GHSA-aaaa','CVE-1','dependabot','CRITICAL','proto','lodash','npm','< 4.17.21','4.17.21',now()),
        ('a03','s1','GHSA-aaaa','CVE-1','dependabot','CRITICAL','proto','lodash','npm','< 4.17.21','4.17.21',now()),
        ('a04','s1','GHSA-aaaa','CVE-1','dependabot','CRITICAL','proto','minimist','npm',NULL,NULL,NULL),
        ('a05','s1','GHSA-bbbb',NULL,'dependabot','HIGH','redos','semver','npm','< 7.5.2',NULL,NULL),
        ('a06','s1','GHSA-bbbb',NULL,'dependabot','HIGH','redos','semver','npm',NULL,NULL,NULL),
        ('a07','s1','GHSA-cccc',NULL,'osv','MEDIUM','xss','minimist','npm',NULL,NULL,NULL),
        ('a08','s2','GHSA-aaaa','CVE-1','dependabot','CRITICAL','proto','lodash','npm',NULL,'4.17.21',NULL),
        ('a09','s3','GHSA-dddd',NULL,'dependabot','HIGH','x','left-pad','npm',NULL,NULL,NULL),
        ('a10','s3','GHSA-eeee',NULL,'osv','LOW','y','left-pad','npm',NULL,NULL,NULL)`,
    );
  }

  it(
    'push fails on duplicates, then dedupe + push succeeds and keeps the most complete row',
    async () => {
      const schema = newSchema('dups');
      const url = urlFor(schema);

      const legacy = run(['prisma', 'db', 'push', '--schema', legacySchemaPath, '--skip-generate'], url);
      expect(legacy.ok, legacy.output).toBe(true);

      const client = new PrismaClient({ datasourceUrl: url });
      try {
        await seedLegacy(client);

        // Negative control: without the dedupe the schema push cannot add the key,
        // even when the data-loss warning is accepted.
        const blocked = run(['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], url);
        expect(blocked.ok, 'push must fail while duplicates exist').toBe(false);
        expect(blocked.output).toMatch(/Unique constraint failed|P2002/);

        const dedupe = run(['prisma', 'db', 'execute', '--file', 'prisma/pre-push/dedupe-advisories.sql', '--schema', 'prisma/schema.prisma'], url);
        expect(dedupe.ok, dedupe.output).toBe(true);

        const push = run(['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], url);
        expect(push.ok, push.output).toBe(true);

        const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM "Advisory" ORDER BY id`,
        );
        // a02 beats a01/a03 (fixedVersion, then smallest id); a05 beats a06
        // (vulnerableRange); every non-duplicate row survives.
        expect(rows.map((r) => r.id)).toEqual(['a02', 'a04', 'a05', 'a07', 'a08', 'a09', 'a10']);

        const scans = await client.$queryRawUnsafe<
          Array<{ id: string; cveCount: number; criticalCount: number; highCount: number; mediumCount: number; lowCount: number; riskScore: number }>
        >(`SELECT id,"cveCount","criticalCount","highCount","mediumCount","lowCount","riskScore" FROM "Scan" ORDER BY id`);
        const byId = Object.fromEntries(scans.map((s) => [s.id, s]));
        // s1 lost 3 rows: 4 remain (critical lodash + minimist, high semver, medium minimist)
        expect(byId.s1).toMatchObject({ cveCount: 4, criticalCount: 2, highCount: 1, mediumCount: 1, lowCount: 0, riskScore: 27 });
        // untouched scans keep their stored numbers
        expect(byId.s2).toMatchObject({ cveCount: 1, criticalCount: 1, riskScore: 10 });
        expect(byId.s3).toMatchObject({ cveCount: 2, highCount: 1, lowCount: 1, riskScore: 5 });

        // The key is enforced from now on.
        await expect(
          client.$executeRawUnsafe(
            `INSERT INTO "Advisory"(id,"scanId","ghsaId",source,severity,summary,"packageName",ecosystem)
             VALUES ('dup','s1','GHSA-aaaa','dependabot','CRITICAL','proto','lodash','npm')`,
          ),
        ).rejects.toThrow();

        // Re-running the deploy step is a no-op.
        expect(run(['prisma', 'db', 'execute', '--file', 'prisma/pre-push/dedupe-advisories.sql', '--schema', 'prisma/schema.prisma'], url).ok).toBe(true);
        const again = await client.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "Advisory"`);
        expect(again[0].n).toBe(7);
      } finally {
        await client.$disconnect();
      }
    },
    180_000,
  );

  it(
    'dedupe is a no-op on a fresh database without tables',
    () => {
      const url = urlFor(newSchema('fresh'));
      const dedupe = run(['prisma', 'db', 'execute', '--file', 'prisma/pre-push/dedupe-advisories.sql', '--schema', 'prisma/schema.prisma'], url);
      expect(dedupe.ok, dedupe.output).toBe(true);
      const push = run(['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], url);
      expect(push.ok, push.output).toBe(true);
    },
    120_000,
  );
});
