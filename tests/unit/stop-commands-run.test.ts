// Unit tests for scripts/ci/stop-commands-run.sh (tracker task 2061f572) and
// a guard that keeps workflow steps running npm/npx behind it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(__dirname, '../../scripts/ci/stop-commands-run.sh');
const WORKFLOWS = path.resolve(__dirname, '../../.github/workflows');

function stubDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-commands-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/bash\n${body}\n`);
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

function run(args: string[], stubs: Record<string, string>) {
  const dir = stubDir(stubs);
  try {
    return spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const FORGED =
  'echo "::error::forged"; echo "::stop-commands::x"; echo "::add-mask::s"; ' +
  'printf "tail ::error::nonl"';

describe('stop-commands-run.sh', () => {
  it('wraps all output between the stop line and a matching resume line', () => {
    const r = run(['fakecmd'], { fakecmd: `${FORGED}; echo oops >&2` });
    expect(r.status).toBe(0);
    const lines = r.stdout.split('\n');
    const m = /^::stop-commands::([0-9a-f]{32})$/.exec(lines[0]);
    expect(m).not.toBeNull();
    const token = m![1];
    const resume = lines.indexOf(`::${token}::`);
    expect(resume).toBeGreaterThan(1);
    expect(lines.slice(resume + 1).join('')).toBe('');
    // Everything printed by the command sits strictly inside the block,
    // including stderr and an unterminated last line.
    const inside = lines.slice(1, resume).join('\n');
    expect(inside).toContain('::error::forged');
    expect(inside).toContain('oops');
    expect(inside).toContain('tail ::error::nonl');
  });

  it("returns the command's exit status and still resumes", () => {
    const r = run(['fakecmd'], { fakecmd: 'echo hi; exit 7' });
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/^::stop-commands::[0-9a-f]{32}\nhi\n\n::[0-9a-f]{32}::\n$/);
  });

  it('fails before running the command when no token can be generated', () => {
    const marker = path.join(os.tmpdir(), `stop-commands-ran-${process.pid}`);
    fs.rmSync(marker, { force: true });
    const r = run(['fakecmd'], { od: 'exit 1', fakecmd: `touch ${marker}; echo ::error::x` });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('fails on a short token', () => {
    const r = run(['fakecmd'], { od: 'echo abc', fakecmd: 'echo ::error::x' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('generates a different random token on each run', () => {
    const tokens = [1, 2, 3].map((n) => {
      const r = run(['fakecmd'], { fakecmd: `echo run${n}` });
      return /^::stop-commands::([0-9a-f]{32})$/m.exec(r.stdout)![1];
    });
    expect(new Set(tokens).size).toBe(3);
  });

  it('draws a 32 hex char token that is not one repeated character', () => {
    for (let n = 0; n < 5; n++) {
      const r = run(['fakecmd'], { fakecmd: 'echo hi' });
      const token = /^::stop-commands::(.*)$/m.exec(r.stdout)![1];
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(new Set(token.split('')).size).toBeGreaterThan(1);
    }
  });

  it('rejects an empty command line', () => {
    expect(run([], {}).status).toBe(2);
  });
});


// Strip one level of matching surrounding YAML quotes from a single-line
// scalar (unescaping \" and \\ for double quotes, '' for single quotes).
function unquote(v: string): string {
  // A comment after the closing quote is not part of the scalar.
  const t = v.trim().replace(/^(["'])(.*)\1[ \t]+#.*$/, '$1$2$1');
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

// Collect every `run:` body (single-line, block scalar `|` / `>`, or plain
// multi-line) of a workflow file as {startLine, lines}.
export function runBodies(text: string): { start: number; lines: string[] }[] {
  const all = text.split('\n');
  const out: { start: number; lines: string[] }[] = [];
  for (let i = 0; i < all.length; i++) {
    // Flow-style step: `- { name: x, run: npm ci }`. Single line only; the
    // value ends at the first unquoted `,` or `}` (run need not be last).
    const flow =
      /^\s*(?:- )?\{.*?\brun:[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,}]*?)[ \t]*[,}].*$/.exec(all[i]);
    if (flow) {
      out.push({ start: i + 1, lines: [unquote(flow[1])] });
      continue;
    }
    const m = /^(\s*)(?:- )?run:[ \t]*(.*)$/.exec(all[i]);
    if (!m) continue;
    // Column of the `run` key: continuation lines sit deeper than it.
    const keyIndent = all[i].indexOf('run:');
    const first = m[2];
    const lines: string[] = [];
    if (first !== '' && !/^[|>][+-]?\d*\s*(#.*)?$/.test(first)) lines.push(unquote(first));
    let j = i + 1;
    for (; j < all.length; j++) {
      const l = all[j];
      if (l.trim() === '') {
        lines.push('');
        continue;
      }
      const indent = l.length - l.trimStart().length;
      if (indent <= keyIndent) break;
      lines.push(l.trim());
    }
    out.push({ start: i + 1, lines });
    i = j - 1;
  }
  return out;
}

const WRAPPED = /stop-commands-run\.sh"?[ \t]+\S+/g;
const NPM_CMD = /(^|[\s;&|(`{])(npm|npx)(?=\s|$)/;

// Lines of every run body that invoke npm or npx (any verb, env-prefixed
// or not, nested in a pipeline or subshell) outside the wrapper.
export function rawNpmLines(text: string): string[] {
  const hits: string[] = [];
  for (const body of runBodies(text)) {
    for (const line of body.lines) {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) continue;
      if (NPM_CMD.test(t.replace(WRAPPED, ''))) hits.push(t);
    }
  }
  return hits;
}

// Steps that run npm without the wrapper on purpose. Key: `file::line`.
const ALLOWED: Record<string, string> = {
  'audit.yml::timeout 60s npm audit --no-fund 2>&1 || true':
    'carries its own inline per-run stop-commands block (report step)',
  'audit.yml::timeout "${AUDIT_TIMEOUT_SECS}s" npm audit --audit-level=high --no-fund --json >"$OUT" 2>"$ERR"':
    'npm output goes to files; stderr is sanitised and printed by scripts/audit-gate.mjs',
  'ci.yml::npm run lint': 'repo tool already installed, repo-derived output, no registry fetch',
  'ci.yml::npm run test:coverage': 'repo tool already installed, repo-derived output, no registry fetch',
  'ci.yml::npm run build': 'next build of repo code, no registry fetch',
  'ci.yml::npm test': 'mcp test script, repo-derived output, no registry fetch',
  'publish-npm.yml::npm run build':
    'local tsc compile, no registry fetch (prepublishOnly runs inside the wrapped publish step)',
};

// GitHub Actions runs both extensions from .github/workflows.
export const isWorkflowFile = (name: string): boolean => /\.ya?ml$/.test(name);

function keyOf(file: string, line: string): string {
  return `${file}::${line}`;
}

describe('workflow steps that print npm output', () => {
  it('route every npm or npx invocation through the wrapper unless allowlisted', () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const f of fs.readdirSync(WORKFLOWS).filter(isWorkflowFile)) {
      const text = fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');
      for (const line of rawNpmLines(text)) {
        const k = keyOf(f, line);
        if (k in ALLOWED) used.add(k);
        else offenders.push(k);
      }
    }
    expect(offenders).toEqual([]);
    // A stale allowlist entry hides nothing today but would excuse a future
    // step silently: keep it exact.
    expect(Object.keys(ALLOWED).filter((k) => !used.has(k))).toEqual([]);
  });

  it('keeps the inline stop-commands block around the audit report step', () => {
    const text = fs.readFileSync(path.join(WORKFLOWS, 'audit.yml'), 'utf8');
    const bodies = runBodies(text).filter((b) =>
      b.lines.includes('timeout 60s npm audit --no-fund 2>&1 || true'),
    );
    expect(bodies).toHaveLength(1);
    const lines = bodies[0].lines;
    const stop = lines.indexOf('echo "::stop-commands::$TOKEN"');
    const npm = lines.indexOf('timeout 60s npm audit --no-fund 2>&1 || true');
    const resume = lines.indexOf("printf '\\n::%s::\\n' \"$TOKEN\"");
    expect(stop).toBeGreaterThan(-1);
    expect(resume).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(npm);
    expect(npm).toBeLessThan(resume);
    // Random token, and a length guard that fails the step before npm
    // output is printed.
    expect(lines).toContain('TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d \' \\n\')"');
    const guard = lines.indexOf('if [ "${#TOKEN}" -ne 32 ]; then');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(stop);
    const fi = lines.indexOf('fi', guard);
    expect(lines.slice(guard + 1, fi)).toContain('exit 1');
    expect(fi).toBeLessThan(stop);
  });

  it('scans .yaml as well as .yml workflow files', () => {
    expect(isWorkflowFile('ci.yml')).toBe(true);
    expect(isWorkflowFile('extra.yaml')).toBe(true);
    expect(isWorkflowFile('README.md')).toBe(false);
  });

  it('flags raw npm in a multi-line run body, env-prefixed and any verb', () => {
    const yml = [
      'steps:',
      '  - name: Publish',
      '    run: |',
      '      set -e',
      '      echo start',
      '      npm publish --access public',
      '  - run: CI=1 npm ci',
      '  - run: >-',
      '      FOO=bar npx tsc',
      '  - run: npm exec foo',
      '  - run: (cd x && npm update)',
      '  - run: "npm ci --no-audit --no-fund"',
      "  - run: 'npm publish --access public --provenance'",
      '  - run: "CI=1 npm \\"ci\\""',
      '  - { name: Flow, run: npm install }',
      '  - { run: "npm view x" }',
      '  - run: bash "$GITHUB_WORKSPACE/scripts/ci/stop-commands-run.sh" npm ci',
      '  - run: bash "$GITHUB_WORKSPACE/scripts/ci/stop-commands-run.sh" npm ci && npm view x',
      '  - run: "npm ci --no-audit" # install',
      '  - { run: "npm pack", name: x }',
      '  - { run: npm ls } # c',
    ].join('\n');
    expect(rawNpmLines(yml)).toEqual([
      'npm publish --access public',
      'CI=1 npm ci',
      'FOO=bar npx tsc',
      'npm exec foo',
      '(cd x && npm update)',
      'npm ci --no-audit --no-fund',
      'npm publish --access public --provenance',
      'CI=1 npm "ci"',
      'npm install',
      'npm view x',
      'bash "$GITHUB_WORKSPACE/scripts/ci/stop-commands-run.sh" npm ci && npm view x',
      'npm ci --no-audit',
      'npm pack',
      'npm ls',
    ]);
  });
});
