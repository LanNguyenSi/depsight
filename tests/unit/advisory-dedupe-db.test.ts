// Deploy-path test for the Advisory unique key: a production database that
// already holds duplicate advisory rows must survive the deploy's schema push.
//
// Production deploys go through the relay: `.relay.yml` post_update runs
// `prisma@5.22.0 db execute --file prisma/pre-push/advisory-unique-key.sql`
// and then a bare `prisma@5.22.0 db push` (no --accept-data-loss). Prisma
// refuses a bare push that adds a unique key, so the SQL creates the index
// itself, under the name Prisma expects. The database half replays exactly the
// commands the hook contains, starting from a copy of the schema as it was
// before the key (tests/fixtures/schema-before-advisory-key.prisma).
//
// That half needs a real Postgres (the migration is SQL plus `prisma db push`,
// nothing a mock can stand in for), so it runs only when
// DEPSIGHT_TEST_DATABASE_URL points at a scratch server, for example
// postgresql://depsight:depsight@127.0.0.1:5432/depsight. Each case works in
// its own schema of that database and drops it afterwards. CI provides the
// server in the `Advisory dedupe (Postgres)` job. The wiring half (the hook
// and the db:push script run the SQL first, the SQL matches what Prisma
// generates) always runs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const ROOT = resolve(__dirname, '../..');
const BASE_URL = process.env.DEPSIGHT_TEST_DATABASE_URL;
const UNIQUE_LINE = '@@unique([scanId, ghsaId, packageName])';
const INDEX_NAME = 'Advisory_scanId_ghsaId_packageName_key';
const SQL_FILE = 'prisma/pre-push/advisory-unique-key.sql';
const BASE_SCHEMA = 'tests/fixtures/schema-before-advisory-key.prisma';

/** The prisma invocations of the relay's post_update command, in order. */
function relayPrismaCommands(): string[][] {
  const relay = readFileSync(join(ROOT, '.relay.yml'), 'utf8');
  const hook = relay.match(/^post_update:\s*\n((?:\s+-.*\n?)+)/m);
  expect(hook, '.relay.yml has a post_update list').not.toBeNull();
  const inner = (hook as RegExpMatchArray)[1].match(/sh -c "([^"]*)"/);
  expect(inner, 'post_update runs its steps through sh -c').not.toBeNull();
  return (inner as RegExpMatchArray)[1]
    .split('&&')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('npx prisma@'))
    .map((part) => part.split(/\s+/).slice(1));
}

describe('deploy wiring', () => {
  it('the relay post_update runs the Advisory SQL before a bare db push', () => {
    const commands = relayPrismaCommands();
    expect(commands.map((c) => c.slice(1, 3).join(' '))).toEqual(['db execute', 'db push']);
    const [execute, push] = commands;
    expect(execute).toContain(`--file`);
    expect(execute[execute.indexOf('--file') + 1]).toBe(SQL_FILE);
    expect(push).toContain('--skip-generate');
    for (const c of commands) expect(c).not.toContain('--accept-data-loss');
    // Both steps are chained with && so a failing SQL step stops the deploy.
    const relay = readFileSync(join(ROOT, '.relay.yml'), 'utf8');
    expect(relay).toMatch(/db execute [^"]*&& npx prisma@\S+ db push/);
  });

  it('no other post_update item pushes the schema around the Advisory SQL', () => {
    // The replay below parses only the sh -c item, so any further item would
    // run unseen. Pin the hook to that one item, and pin that the whole file
    // pushes the schema exactly once, after the SQL step.
    const relay = readFileSync(join(ROOT, '.relay.yml'), 'utf8');
    const hook = relay.match(/^post_update:\s*\n((?:\s+-.*\n?)+)/m) as RegExpMatchArray;
    const items = hook[1].split('\n').filter((line) => /^\s+-\s/.test(line));
    expect(items).toHaveLength(1);
    expect(relay.match(/db push/g)).toHaveLength(1);
    expect(relay.indexOf(`db execute --file ${SQL_FILE}`)).toBeGreaterThan(-1);
    expect(relay.indexOf(`db execute --file ${SQL_FILE}`)).toBeLessThan(relay.indexOf('db push'));
  });

  it('npm run db:push runs the Advisory SQL before prisma db push', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:push']).toMatch(/^npm run db:pre-push && prisma db push/);
    expect(pkg.scripts['db:pre-push']).toContain(SQL_FILE);
    expect(pkg.scripts['db:push']).not.toContain('--accept-data-loss');
  });

  it('the schema carries the unique key the SQL exists for', () => {
    const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
    expect(schema).toContain(UNIQUE_LINE);
  });

  it('the SQL creates the index exactly as Prisma generates it for the schema', () => {
    const generated = execFileSync(
      'npx',
      ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const normalize = (text: string) => text.replace(/\s+/g, ' ').replace(/, /g, ',');
    const expected = generated
      .split('\n')
      .find((line) => line.includes(`"${INDEX_NAME}"`));
    expect(expected, 'Prisma emits the unique index for the Advisory key').toBeDefined();
    const sql = normalize(readFileSync(join(ROOT, SQL_FILE), 'utf8'));
    const statement = normalize(
      (expected as string).replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX IF NOT EXISTS').replace(/;$/, ''),
    );
    expect(sql).toContain(statement);
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

describe.skipIf(!BASE_URL)('Advisory key deploy against Postgres', () => {
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

  beforeAll(() => {
    expect(readFileSync(join(ROOT, BASE_SCHEMA), 'utf8')).not.toContain(UNIQUE_LINE);
  });

  function newSchema(name: string): string {
    const schema = `dedupe_${name}_${process.pid}_${Date.now()}`;
    schemas.push(schema);
    return schema;
  }

  /** Apply the schema the production database had before this release. */
  function pushBaseSchema(url: string) {
    // The older engine, as the relay's image uses; the fixture is the real base schema.
    const out = run(['prisma@5.22.0', 'db', 'push', '--schema', BASE_SCHEMA, '--skip-generate'], url);
    expect(out.ok, out.output).toBe(true);
  }

  /** The deploy hook: every prisma command of the relay's post_update, in order. */
  function runHook(url: string): { ok: boolean; output: string } {
    let output = '';
    for (const args of relayPrismaCommands()) {
      const result = run(args, url);
      output += result.output;
      if (!result.ok) return { ok: false, output };
    }
    return { ok: true, output };
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

  async function indexNames(client: PrismaClient): Promise<string[]> {
    const rows = await client.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'Advisory' ORDER BY indexname`,
    );
    return rows.map((r) => r.indexname);
  }

  async function tableExists(client: PrismaClient, table: string): Promise<boolean> {
    const rows = await client.$queryRawUnsafe<Array<{ found: string | null }>>(
      `SELECT to_regclass('"${table}"')::text AS found`,
    );
    return rows[0].found !== null;
  }

  it(
    'the hook succeeds on a database with duplicates, keeps the most complete row and is repeatable',
    async () => {
      const url = urlFor(newSchema('dups'));
      pushBaseSchema(url);

      const client = new PrismaClient({ datasourceUrl: url });
      try {
        await seedLegacy(client);

        // Negative control: the bare push the relay used to run cannot take the
        // new key, and applies nothing (the new table does not appear).
        const bare = run(['prisma@5.22.0', 'db', 'push', '--skip-generate', '--schema=prisma/schema.prisma'], url);
        expect(bare.ok, 'a bare push must fail without the SQL step').toBe(false);
        expect(await tableExists(client, 'AdvisoryState')).toBe(false);

        const hook = runHook(url);
        expect(hook.ok, hook.output).toBe(true);
        expect(await tableExists(client, 'AdvisoryState')).toBe(true);
        expect(await indexNames(client)).toContain(INDEX_NAME);
        // The unique key leads with scanId, so the old scanId index is gone and
        // dropping it did not need a data-loss flag.
        expect(await indexNames(client)).not.toContain('Advisory_scanId_idx');

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

        // A second deploy (index already exists, schema in sync) is a no-op.
        const indexesBefore = await indexNames(client);
        const second = runHook(url);
        expect(second.ok, second.output).toBe(true);
        expect(await indexNames(client)).toEqual(indexesBefore);
        const again = await client.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "Advisory"`);
        expect(again[0].n).toBe(7);
      } finally {
        await client.$disconnect();
      }
    },
    240_000,
  );

  it(
    'the hook succeeds on a database with an empty Advisory table and is repeatable',
    async () => {
      const url = urlFor(newSchema('empty'));
      pushBaseSchema(url);
      const client = new PrismaClient({ datasourceUrl: url });
      try {
        const first = runHook(url);
        expect(first.ok, first.output).toBe(true);
        expect(await tableExists(client, 'AdvisoryState')).toBe(true);
        expect(await indexNames(client)).toContain(INDEX_NAME);
        const second = runHook(url);
        expect(second.ok, second.output).toBe(true);
      } finally {
        await client.$disconnect();
      }
    },
    240_000,
  );

  it(
    'the hook succeeds on a fresh database without tables',
    async () => {
      const url = urlFor(newSchema('fresh'));
      const client = new PrismaClient({ datasourceUrl: url });
      try {
        const hook = runHook(url);
        expect(hook.ok, hook.output).toBe(true);
        expect(await tableExists(client, 'AdvisoryState')).toBe(true);
        expect(await indexNames(client)).toContain(INDEX_NAME);
      } finally {
        await client.$disconnect();
      }
    },
    240_000,
  );

  it(
    'npm run db:push (repo prisma) succeeds on a database with duplicates without extra flags',
    async () => {
      const url = urlFor(newSchema('npm'));
      pushBaseSchema(url);
      const client = new PrismaClient({ datasourceUrl: url });
      try {
        await seedLegacy(client);
        const push = run(['run', 'db:push', '--', '--skip-generate'], url, 'npm');
        expect(push.ok, push.output).toBe(true);
        const count = await client.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "Advisory"`);
        expect(count[0].n).toBe(7);
      } finally {
        await client.$disconnect();
      }
    },
    240_000,
  );
});
