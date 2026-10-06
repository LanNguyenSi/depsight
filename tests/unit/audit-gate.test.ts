// Unit tests for scripts/audit-gate.mjs (tracker task fc7c5ea2).
//
// Fixtures are real npm output captured on 2026-10-06 against this repo
// (npm 11.18): the root tree's `npm audit --audit-level=high --json` report,
// the mcp tree's clean report, and the two npm failure shapes (registry
// unreachable, missing lockfile) with their stderr. Variants for the other
// cases are built from the same shapes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  addDays,
  classify,
  main,
  parseAllowlist,
  advisoryId,
  todayUtc,
  MAX_REVIEW_HORIZON_DAYS,
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_OUTAGE,
  EXIT_UNCLASSIFIED,
} from '../../scripts/audit-gate.mjs';

const ROOT_REPORT = {
  "auditReportVersion": 2,
  "vulnerabilities": {
    "@next/eslint-plugin-next": {
      "name": "@next/eslint-plugin-next",
      "severity": "high",
      "isDirect": false,
      "via": [
        "fast-glob"
      ],
      "effects": [
        "eslint-config-next"
      ],
      "range": ">=14.3.0-canary.0",
      "nodes": [
        "node_modules/@next/eslint-plugin-next"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "braces": {
      "name": "braces",
      "severity": "high",
      "isDirect": false,
      "via": [
        {
          "source": 1240992,
          "name": "braces",
          "dependency": "braces",
          "title": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
          "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
          "severity": "high",
          "cwe": [
            "CWE-674"
          ],
          "cvss": {
            "score": 7.5,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
          },
          "range": "<=3.0.3"
        }
      ],
      "effects": [
        "micromatch"
      ],
      "range": "*",
      "nodes": [
        "node_modules/braces"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "eslint-config-next": {
      "name": "eslint-config-next",
      "severity": "high",
      "isDirect": true,
      "via": [
        "@next/eslint-plugin-next"
      ],
      "effects": [],
      "range": ">=14.3.0-canary.0",
      "nodes": [
        "node_modules/eslint-config-next"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "fast-glob": {
      "name": "fast-glob",
      "severity": "high",
      "isDirect": false,
      "via": [
        "micromatch"
      ],
      "effects": [
        "@next/eslint-plugin-next"
      ],
      "range": "*",
      "nodes": [
        "node_modules/fast-glob"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    },
    "micromatch": {
      "name": "micromatch",
      "severity": "high",
      "isDirect": false,
      "via": [
        "braces"
      ],
      "effects": [
        "fast-glob"
      ],
      "range": ">=0.2.0",
      "nodes": [
        "node_modules/micromatch"
      ],
      "fixAvailable": {
        "name": "eslint-config-next",
        "version": "14.2.35",
        "isSemVerMajor": true
      }
    }
  },
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 5,
      "critical": 0,
      "total": 5
    },
    "dependencies": {
      "prod": 129,
      "dev": 418,
      "optional": 116,
      "peer": 0,
      "peerOptional": 0,
      "total": 583
    }
  }
};

const MCP_REPORT = {
  "auditReportVersion": 2,
  "vulnerabilities": {},
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 0,
      "critical": 0,
      "total": 0
    },
    "dependencies": {
      "prod": 94,
      "dev": 119,
      "optional": 53,
      "peer": 0,
      "peerOptional": 0,
      "total": 212
    }
  }
};

// npm with the registry unreachable: JSON error body on stdout, text on stderr.
const OUTAGE_STDOUT = "{\n  \"message\": \"request to http://127.0.0.1:1/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:1\",\n  \"error\": {\n    \"summary\": \"\",\n    \"detail\": \"\"\n  }\n}";
const OUTAGE_STDERR = "npm warn audit request to http://127.0.0.1:1/-/npm/v1/security/advisories/bulk failed, reason: connect ECONNREFUSED 127.0.0.1:1\nnpm error audit endpoint returned an error\nnpm error A complete log of this run can be found in: <npm-log-path>\n";

// npm run in a directory without a lockfile.
const NOLOCK_STDOUT = "{\n  \"error\": {\n    \"code\": \"ENOLOCK\",\n    \"summary\": \"This command requires an existing lockfile.\",\n    \"detail\": \"Try creating one first with: npm i --package-lock-only\\nOriginal error: loadVirtual requires existing shrinkwrap file\"\n  }\n}";
const NOLOCK_STDERR = "npm error code ENOLOCK\nnpm error audit This command requires an existing lockfile.\nnpm error audit Try creating one first with: npm i --package-lock-only\nnpm error audit Original error: loadVirtual requires existing shrinkwrap file\nnpm error A complete log of this run can be found in: <npm-log-path>\n";

const BRACES_ID = 'GHSA-vfj7-8cjw-p6xm';
const OTHER_ID = 'GHSA-cccc-ffff-gggg';
const CRIT_ID = 'GHSA-2222-3333-4444';
const TODAY = '2026-10-06';
const REPO_ROOT = path.resolve(__dirname, '../..');

type Json = Record<string, unknown>;

function allowlist(entries: Json[] = [defaultEntry()]): string {
  return JSON.stringify({ entries });
}

function defaultEntry(overrides: Json = {}): Json {
  return { id: BRACES_ID, reason: 'dev only, no fix', reviewBy: '2026-11-06', ...overrides };
}

function advisory(id: string, severity: string, name: string): Json {
  return {
    source: 1000000,
    name,
    dependency: name,
    title: 'test advisory',
    url: `https://github.com/advisories/${id}`,
    severity,
    cwe: ['CWE-674'],
    cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
    range: '<=1.0.0',
  };
}

function node(name: string, severity: string, via: unknown[], effects: string[] = []): Json {
  return {
    name,
    severity,
    isDirect: false,
    via,
    effects,
    range: '*',
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
}

// The metadata tally is derived from the map, the way npm emits it.
function tally(vulnerabilities: Record<string, Json>) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const entry of Object.values(vulnerabilities)) {
    const severity = (entry as { severity?: string }).severity as keyof typeof counts;
    if (severity in counts && severity !== 'total') counts[severity] += 1;
    counts.total += 1;
  }
  return counts;
}

function report(vulnerabilities: Record<string, Json>): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: tally(vulnerabilities) },
  });
}

function rootReportWith(extra: Record<string, Json>): string {
  return report({ ...(ROOT_REPORT.vulnerabilities as Record<string, Json>), ...extra });
}

function run(
  stdout: string,
  opts: { status?: number; stderr?: string; allow?: string; today?: string } = {},
) {
  const result = classify({
    stdout,
    stderr: opts.stderr ?? '',
    status: opts.status ?? 1,
    allowlistText: opts.allow ?? allowlist(),
    allowlistFile: '.github/audit-allowlist.json',
    today: opts.today ?? TODAY,
  });
  return { exitCode: result.exitCode, text: result.lines.join('\n') };
}

describe('allowlisted advisory only', () => {
  it('real root report with only the braces chain is CLEAN and prints the entry used', () => {
    const { exitCode, text } = run(JSON.stringify(ROOT_REPORT));
    expect(exitCode).toBe(EXIT_CLEAN);
    expect(text).toContain(`excepted by allowlist: ${BRACES_ID}`);
    expect(text).toContain('reviewBy 2026-11-06');
    for (const pkg of ['braces', 'micromatch', 'fast-glob', '@next/eslint-plugin-next', 'eslint-config-next']) {
      expect(text).toContain(pkg);
    }
    expect(text).toContain('CLEAN');
    expect(text).not.toContain('FINDINGS');
  });
});

describe('findings beside the allowlisted advisory', () => {
  it('another high advisory on an unrelated package is FINDINGS and only that package is listed', () => {
    const stdout = rootReportWith({
      lodash: node('lodash', 'high', [advisory(OTHER_ID, 'high', 'lodash')]),
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`- lodash (high): ${OTHER_ID}`);
    expect(text).not.toContain('- braces');
    expect(text).not.toContain('- micromatch');
  });

  it('a critical advisory on another package under the same parent keeps the parent and the package red', () => {
    const vulns = { ...(ROOT_REPORT.vulnerabilities as Record<string, Json>) };
    // micromatch now depends on braces (allowlisted) AND on evil-glob (critical).
    vulns.micromatch = node('micromatch', 'critical', ['braces', 'evil-glob'], ['fast-glob']);
    vulns['evil-glob'] = node('evil-glob', 'critical', [advisory(CRIT_ID, 'critical', 'evil-glob')], ['micromatch']);
    const { exitCode, text } = run(report(vulns));
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`- evil-glob (critical): ${CRIT_ID}`);
    // The parents inherit the block through the transitive via chain.
    expect(text).toContain(`- micromatch (critical): ${CRIT_ID}`);
    expect(text).toContain(`- fast-glob (high): ${CRIT_ID}`);
    // braces itself is only the allowlisted advisory and stays excepted.
    expect(text).not.toContain('- braces');
  });

  it('a package carrying the allowlisted advisory plus another high advisory is FINDINGS', () => {
    const vulns = { ...(ROOT_REPORT.vulnerabilities as Record<string, Json>) };
    vulns.braces = node('braces', 'high', [advisory(BRACES_ID, 'high', 'braces'), advisory(OTHER_ID, 'high', 'braces')], ['micromatch']);
    const { exitCode, text } = run(report(vulns));
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`- braces (high): ${OTHER_ID}`);
  });

  it('matches the exact GHSA id, never the package name', () => {
    // Same package name as the allowlisted one, different advisory id.
    const stdout = report({
      braces: node('braces', 'high', [advisory(OTHER_ID, 'high', 'braces')]),
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`- braces (high): ${OTHER_ID}`);
  });

  it('a url that is not exactly a GitHub advisory url never matches, even with the allowlisted id inside', () => {
    for (const url of [
      `https://github.com/advisories/${BRACES_ID}/extra`,
      `https://evil.example/advisories/${BRACES_ID}`,
      `https://github.com/advisories/${BRACES_ID}?x=1`,
      `https://npmjs.com/advisories/1240992`,
    ]) {
      const via = { ...advisory(BRACES_ID, 'high', 'braces'), url };
      const { exitCode, text } = run(report({ braces: node('braces', 'high', [via]) }));
      expect(exitCode).toBe(EXIT_FINDINGS);
      expect(text).toContain('- braces (high)');
    }
    expect(advisoryId({ url: `https://github.com/advisories/${BRACES_ID}` })).toBe(BRACES_ID);
    expect(advisoryId({ url: `https://github.com/advisories/${BRACES_ID}/x` })).toBeNull();
    expect(advisoryId({})).toBeNull();
  });

  it('a high package whose via chain names a package missing from the report stays a finding', () => {
    const { exitCode, text } = run(report({ a: node('a', 'high', ['ghost']) }));
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain('- a (high): unresolvable:ghost');
  });

  it('a high package with no resolvable advisory is a finding, not vacuously excepted', () => {
    const { exitCode, text } = run(report({ a: node('a', 'high', []) }));
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain('- a (high): no-advisory-resolved');
  });
});

describe('fail-open guards beside the allowlisted advisory', () => {
  // Each case keeps the allowlisted braces advisory in the report, so a guard
  // that silently drops the odd entry would turn the whole run green.
  const bracesNode = () => node('braces', 'high', [advisory(BRACES_ID, 'high', 'braces')], ['micromatch']);

  it('a via string naming a package missing from the report keeps the allowlisted package red', () => {
    const stdout = report({
      braces: node('braces', 'high', [advisory(BRACES_ID, 'high', 'braces'), 'ghost']),
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain('- braces (high): unresolvable:ghost');
  });

  it.each([
    ['a number', 42],
    ['null', null],
  ])('a via entry that is %s (neither string nor object) is a finding', (_name, odd) => {
    const stdout = report({
      braces: node('braces', 'high', [advisory(BRACES_ID, 'high', 'braces'), odd]),
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain('- braces (high): unresolvable:braces');
  });

  it.each([
    ['a number', 42],
    ['a plain object', {}],
  ])('a vulnerability node whose via is %s (not an array) is a classified finding', (_name, odd) => {
    const stdout = report({
      braces: bracesNode(),
      micromatch: { ...node('micromatch', 'high', ['braces']), via: odd },
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain('npm audit gate: FINDINGS');
    expect(text).toContain('- micromatch (high)');
  });

  it('a null vulnerability node is a finding, not skipped', () => {
    const stdout = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: { braces: bracesNode(), broken: null },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain('- broken (unknown): unresolvable');
  });

  it('a moderate-labelled package carrying a high advisory is a finding', () => {
    // npm labels a package by its own range severity; the advisory object in
    // via can still be high. Checking only the node label would miss it.
    const stdout = report({
      braces: bracesNode(),
      mislabelled: node('mislabelled', 'moderate', [advisory(OTHER_ID, 'high', 'mislabelled')]),
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`- mislabelled (moderate): ${OTHER_ID}`);
  });

  it('a high-labelled package whose advisories are all moderate is still a finding (not vacuously excepted)', () => {
    const stdout = report({
      braces: bracesNode(),
      soft: node('soft', 'high', [advisory(OTHER_ID, 'moderate', 'soft')]),
    });
    // No gating advisory resolves for `soft`, so it is reported rather than
    // vacuously excepted.
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain('- soft (high): no-advisory-resolved');
  });
});

describe('transitive via chains', () => {
  it('terminates on a cycle and keeps an allowlisted cycle excepted', () => {
    const stdout = report({
      a: node('a', 'high', ['b'], ['b']),
      b: node('b', 'high', ['a', advisory(BRACES_ID, 'high', 'b')], ['a']),
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_CLEAN);
    expect(text).toContain('for a, b');
  });

  it('terminates on a cycle and reports a blocking advisory inside it', () => {
    const stdout = report({
      a: node('a', 'high', ['b'], ['b']),
      b: node('b', 'high', ['a', advisory(OTHER_ID, 'high', 'b')], ['a']),
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`- a (high): ${OTHER_ID}`);
    expect(text).toContain(`- b (high): ${OTHER_ID}`);
  });

  it('a lower-severity advisory in the chain does not gate', () => {
    const stdout = report({
      a: node('a', 'moderate', [advisory(OTHER_ID, 'moderate', 'a')]),
      b: node('b', 'high', [advisory(BRACES_ID, 'high', 'b'), advisory(CRIT_ID, 'low', 'b')]),
    });
    const { exitCode } = run(stdout);
    expect(exitCode).toBe(EXIT_CLEAN);
  });
});

describe('allowlist expiry and unmatched entries', () => {
  it('an entry whose reviewBy is before today fails with FINDINGS naming the id', () => {
    const allow = allowlist([defaultEntry({ reviewBy: '2026-10-05' })]);
    const { exitCode, text } = run(JSON.stringify(ROOT_REPORT), { allow });
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`allowlist entry ${BRACES_ID} expired`);
    expect(text).toContain('reviewBy 2026-10-05');
  });

  it('an expired entry fails even when the advisory is gone (clean report)', () => {
    const allow = allowlist([defaultEntry({ reviewBy: '2020-01-01' })]);
    const { exitCode, text } = run(JSON.stringify(MCP_REPORT), { status: 0, allow });
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`allowlist entry ${BRACES_ID} expired`);
  });

  it('an expired entry never prints a CLEAN verdict', () => {
    const allow = allowlist([defaultEntry({ reviewBy: '2026-10-05' })]);
    const { text } = run(JSON.stringify(ROOT_REPORT), { allow });
    expect(text).not.toContain('CLEAN');
    expect(text).not.toContain('excepted by allowlist');
  });

  it('an expired entry beside a real finding reports both and still exits 1', () => {
    const allow = allowlist([defaultEntry({ reviewBy: '2026-10-05' })]);
    const stdout = rootReportWith({
      lodash: node('lodash', 'high', [advisory(OTHER_ID, 'high', 'lodash')]),
    });
    const { exitCode, text } = run(stdout, { allow });
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`allowlist entry ${BRACES_ID} expired`);
    expect(text).toContain(`- lodash (high): ${OTHER_ID}`);
  });

  it('reviewBy equal to today is still valid, the day after fails', () => {
    const allow = allowlist([defaultEntry({ reviewBy: TODAY })]);
    expect(run(JSON.stringify(ROOT_REPORT), { allow }).exitCode).toBe(EXIT_CLEAN);
    expect(run(JSON.stringify(ROOT_REPORT), { allow, today: '2026-10-07' }).exitCode).toBe(EXIT_FINDINGS);
  });

  it('an unmatched entry is a warning only', () => {
    const { exitCode, text } = run(JSON.stringify(MCP_REPORT), { status: 0 });
    expect(exitCode).toBe(EXIT_CLEAN);
    expect(text).toContain(`::warning::`);
    expect(text).toContain(`${BRACES_ID} matched no advisory`);
  });

  it('no unmatched warning when the id matched but its package is still a finding', () => {
    const stdout = report({
      braces: node('braces', 'high', [advisory(BRACES_ID, 'high', 'braces'), advisory(OTHER_ID, 'high', 'braces')]),
    });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`- braces (high): ${OTHER_ID}`);
    expect(text).not.toContain('matched no advisory');
  });

  it('still warns for an id that appears in no via chain, beside a real finding', () => {
    const stdout = report({ lodash: node('lodash', 'high', [advisory(OTHER_ID, 'high', 'lodash')]) });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain(`${BRACES_ID} matched no advisory`);
  });

  it('todayUtc uses the UTC date', () => {
    expect(todayUtc(new Date('2026-10-06T23:59:59-05:00'))).toBe('2026-10-07');
    expect(todayUtc(new Date('2026-10-06T00:00:00Z'))).toBe('2026-10-06');
    // An instant whose local date is already the next day east of UTC.
    expect(todayUtc(new Date('2026-10-06T23:30:00Z'))).toBe('2026-10-06');
  });
});

describe('clean reports', () => {
  it('the real mcp report (no vulnerabilities, exit 0) is CLEAN', () => {
    const { exitCode, text } = run(JSON.stringify(MCP_REPORT), { status: 0 });
    expect(exitCode).toBe(EXIT_CLEAN);
    expect(text).toContain('CLEAN');
  });

  it('moderate-only vulnerabilities (npm exit 0 at audit-level=high) are CLEAN', () => {
    const stdout = report({ a: node('a', 'moderate', [advisory(OTHER_ID, 'moderate', 'a')]) });
    expect(run(stdout, { status: 0 }).exitCode).toBe(EXIT_CLEAN);
  });
});

describe('OUTAGE', () => {
  it('registry unreachable: npm JSON error body plus stderr is OUTAGE, not UNCLASSIFIED', () => {
    const { exitCode, text } = run(OUTAGE_STDOUT, { stderr: OUTAGE_STDERR });
    expect(exitCode).toBe(EXIT_OUTAGE);
    expect(text).toContain('OUTAGE');
    expect(text).toContain('NOT an advisory finding');
  });

  it('stderr text alone is enough (non-JSON stdout)', () => {
    const { exitCode } = run('', { stderr: 'npm error code E503\nnpm error 503 Service Unavailable' });
    expect(exitCode).toBe(EXIT_OUTAGE);
  });

  it('the local timeout (status 124, empty output) is OUTAGE', () => {
    const { exitCode, text } = run('', { status: 124 });
    expect(exitCode).toBe(EXIT_OUTAGE);
    expect(text).toContain('ERR_SOCKET_TIMEOUT');
  });

  it('a timeout is OUTAGE even when partial junk was printed', () => {
    expect(run('{"auditRep', { status: 124 }).exitCode).toBe(EXIT_OUTAGE);
  });

  it('a real report wins over outage-like text elsewhere (a package named network)', () => {
    const stdout = report({ network: node('network', 'high', [advisory(OTHER_ID, 'high', 'network')]) });
    const { exitCode, text } = run(stdout, { stderr: 'npm warn network retry' });
    expect(exitCode).toBe(EXIT_FINDINGS);
    expect(text).toContain('- network (high)');
  });
});

describe('UNCLASSIFIED', () => {
  it('a missing lockfile (ENOLOCK) is UNCLASSIFIED', () => {
    const { exitCode, text } = run(NOLOCK_STDOUT, { stderr: NOLOCK_STDERR });
    expect(exitCode).toBe(EXIT_UNCLASSIFIED);
    expect(text).toContain('UNCLASSIFIED');
  });

  it('exit 0 without any audit report is UNCLASSIFIED', () => {
    expect(run('', { status: 0 }).exitCode).toBe(EXIT_UNCLASSIFIED);
  });

  it('non-zero npm status with a report holding nothing gating is UNCLASSIFIED', () => {
    const { exitCode } = run(JSON.stringify(MCP_REPORT), { status: 1 });
    expect(exitCode).toBe(EXIT_UNCLASSIFIED);
  });

  it('a report with an unexpected npm exit status is UNCLASSIFIED', () => {
    expect(run(JSON.stringify(ROOT_REPORT), { status: 7 }).exitCode).toBe(EXIT_UNCLASSIFIED);
  });

  it('an unknown report version is UNCLASSIFIED, never trusted', () => {
    const stdout = JSON.stringify({ auditReportVersion: 1, vulnerabilities: {} });
    expect(run(stdout, { status: 0 }).exitCode).toBe(EXIT_UNCLASSIFIED);
  });
});

describe('malformed allowlist', () => {
  const cases: Array<[string, string]> = [
    ['not JSON', '{ nope'],
    ['top level array', '[]'],
    ['unknown top-level key', JSON.stringify({ entries: [], extra: 1 })],
    ['entries not an array', JSON.stringify({ entries: {} })],
    ['missing id', allowlist([{ reason: 'x', reviewBy: '2026-11-06' }])],
    ['missing reason', allowlist([{ id: BRACES_ID, reviewBy: '2026-11-06' }])],
    ['missing reviewBy', allowlist([{ id: BRACES_ID, reason: 'x' }])],
    ['empty reason', allowlist([defaultEntry({ reason: '  ' })])],
    ['unknown entry key', allowlist([defaultEntry({ severity: 'high' })])],
    ['id not a GHSA id', allowlist([defaultEntry({ id: 'braces' })])],
    ['reviewBy not a date', allowlist([defaultEntry({ reviewBy: 'next month' })])],
    ['reviewBy impossible date', allowlist([defaultEntry({ reviewBy: '2026-02-30' })])],
    ['duplicate id', allowlist([defaultEntry(), defaultEntry()])],
    ['entry not an object', JSON.stringify({ entries: ['x'] })],
  ];

  it.each(cases)('%s gives UNCLASSIFIED naming the file', (_name, allow) => {
    const { exitCode, text } = run(JSON.stringify(ROOT_REPORT), { allow });
    expect(exitCode).toBe(EXIT_UNCLASSIFIED);
    expect(text).toContain('.github/audit-allowlist.json');
  });

  it('is checked before the audit result (an outage with a broken allowlist is not hidden)', () => {
    const { exitCode } = run('', { status: 124, allow: '{ nope' });
    expect(exitCode).toBe(EXIT_UNCLASSIFIED);
  });

  it('a reviewBy more than 90 days after today is UNCLASSIFIED naming the file and the id', () => {
    const latest = addDays(TODAY, MAX_REVIEW_HORIZON_DAYS);
    const far = addDays(TODAY, MAX_REVIEW_HORIZON_DAYS + 1);
    const { exitCode, text } = run(JSON.stringify(ROOT_REPORT), {
      allow: allowlist([defaultEntry({ reviewBy: far })]),
    });
    expect(exitCode).toBe(EXIT_UNCLASSIFIED);
    expect(text).toContain('.github/audit-allowlist.json');
    expect(text).toContain(BRACES_ID);
    expect(text).toContain(`reviewBy ${far}`);
    expect(text).toContain(`latest accepted date is ${latest}`);
    expect(run(JSON.stringify(ROOT_REPORT), { allow: allowlist([defaultEntry({ reviewBy: '2999-01-01' })]) }).exitCode).toBe(
      EXIT_UNCLASSIFIED,
    );
  });

  it('exactly 90 days after today is still valid; the horizon is stated as 90 days', () => {
    expect(MAX_REVIEW_HORIZON_DAYS).toBe(90);
    expect(addDays('2026-10-06', 90)).toBe('2027-01-04');
    const allow = allowlist([defaultEntry({ reviewBy: addDays(TODAY, 90) })]);
    expect(run(JSON.stringify(ROOT_REPORT), { allow }).exitCode).toBe(EXIT_CLEAN);
  });

  it('the horizon is checked even when the audit result would be an outage', () => {
    const allow = allowlist([defaultEntry({ reviewBy: addDays(TODAY, 91) })]);
    expect(run('', { status: 124, allow }).exitCode).toBe(EXIT_UNCLASSIFIED);
  });

  it('an empty entries list is valid', () => {
    expect(parseAllowlist('{"entries":[]}', 'f')).toEqual([]);
  });
});

describe('log output hygiene', () => {
  it('a package name or reason cannot forge a workflow command line', () => {
    const evil = 'x\n::error::forged';
    const allow = allowlist([defaultEntry({ reason: 'ok\n::warning::forged' })]);
    const stdout = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        [evil]: node(evil, 'high', [advisory(OTHER_ID, 'high', evil)]),
        braces: node('braces', 'high', [advisory(BRACES_ID, 'high', 'braces')]),
      },
    });
    const { text } = run(stdout, { allow });
    for (const line of text.split('\n')) {
      expect(line.startsWith('::') ? /^::(error|warning)::npm audit gate: /.test(line) : true).toBe(true);
    }
    expect(text).not.toContain('\n::error::forged');
    expect(text).not.toContain('\n::warning::forged');
  });
});

describe('metadata cross-check', () => {
  const vulnerabilities = ROOT_REPORT.vulnerabilities as Record<string, Json>;
  const withTally = (high: number, critical: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities,
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical, total: high + critical } },
      ...extra,
    });

  it('a tally with criticals the map does not show is UNCLASSIFIED, not CLEAN', () => {
    const { exitCode, text } = run(withTally(5, 2));
    expect(exitCode).toBe(EXIT_UNCLASSIFIED);
    expect(text).toContain('UNCLASSIFIED: inconsistent audit report');
    expect(text).not.toContain('CLEAN');
  });

  it('a tally lower than the map is UNCLASSIFIED as well', () => {
    expect(run(withTally(1, 0)).exitCode).toBe(EXIT_UNCLASSIFIED);
  });

  it('a report without a metadata tally is UNCLASSIFIED', () => {
    const stdout = JSON.stringify({ auditReportVersion: 2, vulnerabilities });
    const { exitCode, text } = run(stdout);
    expect(exitCode).toBe(EXIT_UNCLASSIFIED);
    expect(text).toContain('no metadata.vulnerabilities tally');
  });

  it('non-integer counts are UNCLASSIFIED', () => {
    expect(run(withTally('5' as unknown as number, 0)).exitCode).toBe(EXIT_UNCLASSIFIED);
  });

  it('a matching tally keeps the allowlisted-only report CLEAN', () => {
    expect(run(withTally(5, 0)).exitCode).toBe(EXIT_CLEAN);
  });
});

describe('npm stderr sanitising', () => {
  const stderr = [
    '::error::forged finding',
    'npm error ::set-output name=x::y',
    '::stop-commands::token',
    'npm error line\u2028::warning::split',
  ].join('\n');

  it('no stderr line starts a workflow command', () => {
    const { text } = run(JSON.stringify(ROOT_REPORT), { stderr });
    for (const line of text.split('\n')) {
      expect(/^::(?!(error|warning)::npm audit gate: )/.test(line)).toBe(false);
    }
    expect(text).not.toContain('::stop-commands::');
    expect(text).not.toContain('::set-output');
    expect(text).not.toContain('::error::forged');
    expect(text).not.toContain('::warning::split');
    expect(text).toContain('npm stderr| ');
    expect(text).toContain('forged finding');
  });

  it('the same holds when the stderr text decides an OUTAGE', () => {
    const { exitCode, text } = run('', { stderr: '::error::forged\nnpm error code ENOTFOUND' });
    expect(exitCode).toBe(EXIT_OUTAGE);
    expect(text).not.toContain('\n::error::forged');
    expect(text.startsWith('::error::forged')).toBe(false);
  });

  it('a long stderr is bounded', () => {
    const { text } = run(JSON.stringify(ROOT_REPORT), { stderr: 'x\n'.repeat(500) });
    expect(text.split('\n').length).toBeLessThan(80);
    expect(text).toContain('more line(s) omitted');
  });
});

describe('repository allowlist file', () => {
  it('parses and holds exactly one entry, for GHSA-vfj7-8cjw-p6xm', () => {
    const file = path.join(REPO_ROOT, '.github/audit-allowlist.json');
    const entries = parseAllowlist(fs.readFileSync(file, 'utf8'), file);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(BRACES_ID);
    expect(entries[0].reason.length).toBeGreaterThan(0);
    expect(entries[0].reviewBy).toBe('2026-11-06');
    // Valid for the horizon check as of the date this entry was reviewed.
    expect(() => parseAllowlist(fs.readFileSync(file, 'utf8'), file, '2026-10-06')).not.toThrow();
  });
});

describe('main (CLI wrapper)', () => {
  function tmpFiles(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsight-audit-gate-'));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return dir;
  }
  function cli(argv: string[]) {
    const logged: string[] = [];
    const code = main(argv, {
      log: (line: string) => logged.push(line),
      readFile: fs.readFileSync as never,
    });
    return { code, text: logged.join('\n') };
  }

  it('classifies captured files and returns the exit code', () => {
    const dir = tmpFiles({
      'allow.json': allowlist([defaultEntry({ reviewBy: addDays(todayUtc(), 30) })]),
      'out.json': JSON.stringify(ROOT_REPORT),
      'err.txt': '',
    });
    const { code, text } = cli([
      '--allowlist', path.join(dir, 'allow.json'),
      '--status', '1',
      '--stdout', path.join(dir, 'out.json'),
      '--stderr', path.join(dir, 'err.txt'),
    ]);
    expect(code).toBe(EXIT_CLEAN);
    expect(text).toContain('CLEAN');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a missing allowlist file is UNCLASSIFIED naming the file', () => {
    const dir = tmpFiles({ 'out.json': JSON.stringify(ROOT_REPORT) });
    const missing = path.join(dir, 'nope.json');
    const { code, text } = cli(['--allowlist', missing, '--status', '1', '--stdout', path.join(dir, 'out.json')]);
    expect(code).toBe(EXIT_UNCLASSIFIED);
    expect(text).toContain('nope.json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an unreadable captured output is UNCLASSIFIED', () => {
    const dir = tmpFiles({ 'allow.json': allowlist() });
    const { code } = cli(['--allowlist', path.join(dir, 'allow.json'), '--status', '1', '--stdout', path.join(dir, 'gone.json')]);
    expect(code).toBe(EXIT_UNCLASSIFIED);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bad usage is UNCLASSIFIED', () => {
    expect(cli([]).code).toBe(EXIT_UNCLASSIFIED);
    expect(cli(['--allowlist', 'a', '--status', 'x', '--stdout', 'b']).code).toBe(EXIT_UNCLASSIFIED);
    expect(cli(['--bogus', 'a']).code).toBe(EXIT_UNCLASSIFIED);
  });
});

describe('CLI entry point (spawned as a real process)', () => {
  // The gate step runs `node scripts/audit-gate.mjs`. If the entry-point check
  // ever fails to recognise the script, main() never runs and node exits 0:
  // a green gate with findings. These tests spawn the real process, through
  // the real path and through symlinks, and assert the verdict, not just the
  // exit status (an uncaught exception also exits 1).
  const SCRIPT = path.join(REPO_ROOT, 'scripts/audit-gate.mjs');
  const FINDING_REPORT = report({ lodash: node('lodash', 'high', [advisory(OTHER_ID, 'high', 'lodash')]) });

  function fixtureDir(stdout: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'depsight-audit-gate-cli-')));
    fs.writeFileSync(path.join(dir, 'allow.json'), allowlist([defaultEntry({ reviewBy: addDays(todayUtc(), 30) })]));
    fs.writeFileSync(path.join(dir, 'out.json'), stdout);
    return dir;
  }

  function spawnGate(scriptPath: string, dir: string, status: string) {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--allowlist', path.join(dir, 'allow.json'), '--status', status, '--stdout', path.join(dir, 'out.json')],
      { encoding: 'utf8', cwd: dir },
    );
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('real path: a non-allowlisted high advisory exits 1 with a FINDINGS line', () => {
    const dir = fixtureDir(FINDING_REPORT);
    try {
      const { code, stdout, stderr } = spawnGate(SCRIPT, dir, '1');
      expect({ code, stderr }).toEqual({ code: EXIT_FINDINGS, stderr: '' });
      expect(stdout).toContain('npm audit gate: FINDINGS: 1 package(s)');
      expect(stdout).toContain(`- lodash (high): ${OTHER_ID}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('through a symlink to the script: still exits 1 with a FINDINGS line', () => {
    const dir = fixtureDir(FINDING_REPORT);
    try {
      const link = path.join(dir, 'gate-link.mjs');
      fs.symlinkSync(SCRIPT, link);
      const { code, stdout, stderr } = spawnGate(link, dir, '1');
      expect({ code, stderr }).toEqual({ code: EXIT_FINDINGS, stderr: '' });
      expect(stdout).toContain('npm audit gate: FINDINGS: 1 package(s)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('through a symlink with --preserve-symlinks-main: still exits 1 with a FINDINGS line', () => {
    const dir = fixtureDir(FINDING_REPORT);
    try {
      const link = path.join(dir, 'gate-psm.mjs');
      fs.symlinkSync(SCRIPT, link);
      const result = spawnSync(
        process.execPath,
        ['--preserve-symlinks-main', link, '--allowlist', path.join(dir, 'allow.json'), '--status', '1', '--stdout', path.join(dir, 'out.json')],
        { encoding: 'utf8', cwd: dir },
      );
      expect(result.status).toBe(EXIT_FINDINGS);
      expect(result.stdout).toContain('npm audit gate: FINDINGS: 1 package(s)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('through a symlinked directory and a chain of symlinks: still exits 1 with a FINDINGS line', () => {
    const dir = fixtureDir(FINDING_REPORT);
    try {
      const dirLink = path.join(dir, 'scripts-link');
      fs.symlinkSync(path.dirname(SCRIPT), dirLink);
      const viaDir = spawnGate(path.join(dirLink, 'audit-gate.mjs'), dir, '1');
      expect(viaDir.code).toBe(EXIT_FINDINGS);
      expect(viaDir.stdout).toContain('npm audit gate: FINDINGS: 1 package(s)');

      const first = path.join(dir, 'first.mjs');
      const second = path.join(dir, 'second.mjs');
      fs.symlinkSync(SCRIPT, first);
      fs.symlinkSync(first, second);
      const viaChain = spawnGate(second, dir, '1');
      expect(viaChain.code).toBe(EXIT_FINDINGS);
      expect(viaChain.stdout).toContain('npm audit gate: FINDINGS: 1 package(s)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('negative control: the allowlisted-only report exits 0 with CLEAN through the real path and a symlink', () => {
    const dir = fixtureDir(JSON.stringify(ROOT_REPORT));
    try {
      const link = path.join(dir, 'gate-link.mjs');
      fs.symlinkSync(SCRIPT, link);
      for (const scriptPath of [SCRIPT, link]) {
        const { code, stdout } = spawnGate(scriptPath, dir, '1');
        expect(code).toBe(EXIT_CLEAN);
        expect(stdout).toContain('npm audit gate: CLEAN');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
