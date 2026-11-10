-- Run BEFORE `prisma db push` whenever the schema carries
-- @@unique([scanId, ghsaId, packageName]) on "Advisory". `db push` refuses to
-- add a unique key without --accept-data-loss (Prisma warns for every new
-- unique key, duplicates or not) and cannot add one over rows that already
-- violate it. This file removes the duplicates and creates the index itself,
-- under the exact name and columns Prisma generates for the schema line, so
-- the push that follows finds the schema already in sync and has nothing to
-- warn about. The deploy hook (.relay.yml post_update) and `npm run db:push`
-- both run it first, via `prisma db execute`.
--
-- The file also carries a second, independent step at the end: it replaces
-- every plaintext "ApiToken"."token" with its SHA-256 (see the comment there).
-- It lives in this file because every place that applies the schema (the
-- hosted migrate service, `npm run db:push`, the dev entrypoint, the restore
-- drill) already runs exactly this one file before `prisma db push`.
--
-- Safe to run any number of times and on any database state:
--   * no "Advisory" table yet (fresh database): nothing happens, the push
--     creates the table and the key;
--   * no duplicates: nothing is deleted and no Scan row is touched;
--   * the index already exists: nothing happens.
--
-- For each (scanId, ghsaId, packageName) group one row survives: the most
-- complete one (a fixedVersion, then a vulnerableRange, then a publishedAt),
-- ties broken by the smallest id so the choice is deterministic. Every Scan
-- that lost rows has its CVE counts and risk score recomputed from the rows
-- that remain, with the same weights the scanner uses
-- (critical 10, high 5, medium 2, low 0.5, capped at 100).
DO $$
BEGIN
  IF to_regclass('"Advisory"') IS NULL OR to_regclass('"Scan"') IS NULL THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE depsight_dup_advisories ON COMMIT DROP AS
  SELECT id, "scanId"
  FROM (
    SELECT
      id,
      "scanId",
      ROW_NUMBER() OVER (
        PARTITION BY "scanId", "ghsaId", "packageName"
        ORDER BY
          ("fixedVersion" IS NOT NULL) DESC,
          ("vulnerableRange" IS NOT NULL) DESC,
          ("publishedAt" IS NOT NULL) DESC,
          id ASC
      ) AS rn
    FROM "Advisory"
  ) ranked
  WHERE rn > 1;

  DELETE FROM "Advisory" WHERE id IN (SELECT id FROM depsight_dup_advisories);

  UPDATE "Scan" s
  SET
    "cveCount"      = c.total,
    "criticalCount" = c.critical,
    "highCount"     = c.high,
    "mediumCount"   = c.medium,
    "lowCount"      = c.low,
    "riskScore"     = LEAST(100, ROUND(c.critical * 10 + c.high * 5 + c.medium * 2 + c.low * 0.5))
  FROM (
    SELECT
      d."scanId",
      COUNT(a.id)                                     AS total,
      COUNT(a.id) FILTER (WHERE a.severity = 'CRITICAL') AS critical,
      COUNT(a.id) FILTER (WHERE a.severity = 'HIGH')     AS high,
      COUNT(a.id) FILTER (WHERE a.severity = 'MEDIUM')   AS medium,
      COUNT(a.id) FILTER (WHERE a.severity = 'LOW')      AS low
    FROM (SELECT DISTINCT "scanId" FROM depsight_dup_advisories) d
    LEFT JOIN "Advisory" a ON a."scanId" = d."scanId"
    GROUP BY d."scanId"
  ) c
  WHERE s.id = c."scanId";

  CREATE UNIQUE INDEX IF NOT EXISTS "Advisory_scanId_ghsaId_packageName_key"
    ON "Advisory"("scanId", "ghsaId", "packageName");
END
$$;

-- API tokens at rest: "ApiToken"."token" holds the lowercase hex SHA-256 of the
-- raw `dsat_...` token (lib/api-token.ts), not the token. Rows written before
-- that change still hold the raw value; hash them in place so the tokens keep
-- working (the app hashes the presented token before the lookup) and a dump of
-- the table no longer contains usable tokens. A digest is 64 hex characters and
-- never starts with `dsat_`, so the WHERE clause selects exactly the rows not
-- yet migrated and a second run changes nothing. sha256(bytea) needs
-- PostgreSQL 11 or later (the compose files use postgres:16). No "ApiToken"
-- table yet (fresh database): nothing happens. The column keeps its unique
-- index; two distinct 256-bit tokens do not collide.
DO $$
BEGIN
  IF to_regclass('"ApiToken"') IS NULL THEN
    RETURN;
  END IF;

  UPDATE "ApiToken"
  SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
  WHERE left("token", 5) = 'dsat_';
END
$$;
