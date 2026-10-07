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

  it('rejects an empty command line', () => {
    expect(run([], {}).status).toBe(2);
  });
});

describe('workflow steps that print npm output', () => {
  it('run npm ci/install/publish/pack/view and npx through the wrapper', () => {
    const offenders: string[] = [];
    for (const f of fs.readdirSync(WORKFLOWS).filter((n) => n.endsWith('.yml'))) {
      fs.readFileSync(path.join(WORKFLOWS, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(- )?run:\s*(npm (ci|install|i|publish|pack|view)\b|npx\b)/.test(line)) {
            offenders.push(`${f}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
