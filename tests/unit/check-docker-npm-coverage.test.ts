// Unit tests for scripts/check-docker-npm-coverage.ts.
//
// Fixtures are inline strings materialised into a fresh temp directory per
// test (no fixture files in the repo). Tracker task 778f3248.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeDockerfile,
  scanRepo,
  formatHuman,
  run,
  npmMajorForImage,
} from '../../scripts/check-docker-npm-coverage';

const tmpDirs: string[] = [];

function mkRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsight-dnc-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

const COVERAGE_PKG = JSON.stringify({ devDependencies: { '@vitest/coverage-v8': '4.1.8' } });
const PLAIN_PKG = JSON.stringify({ devDependencies: { vitest: '4.1.8' } });

// Historical incident form. Source: project-pilot, backend/Dockerfile at
// commit 5e1ba8c (lines 1-5): node:22-alpine builder, package.json copied
// without a lockfile, then a bare `npm install`. backend/package.json at that
// commit carried "@vitest/coverage-v8": "4.1.8". The fix (b737de0) added
// `RUN npm install -g npm@11` before the install.
const INCIDENT = [
  'FROM node:22-alpine AS builder',
  'WORKDIR /app',
  'COPY package.json ./',
  'RUN npm install',
  '',
].join('\n');

function dockerfile(lines: string[]): string {
  return lines.join('\n') + '\n';
}

function incidentWith(overrides: { from?: string; extraBeforeInstall?: string[]; install?: string }): string {
  return dockerfile([
    overrides.from ?? 'FROM node:22-alpine AS builder',
    'WORKDIR /app',
    'COPY package.json ./',
    ...(overrides.extraBeforeInstall ?? []),
    overrides.install ?? 'RUN npm install',
  ]);
}

function scan(files: Record<string, string>) {
  return scanRepo(mkRepo(files));
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } };
}

describe('incident shape', () => {
  it('flags the historical incident Dockerfile as confirmed with npm 10 on line 4', () => {
    const dir = mkRepo({ Dockerfile: INCIDENT, 'package.json': COVERAGE_PKG });
    const report = scanRepo(dir);
    expect(report.findings).toHaveLength(1);
    const f = report.findings[0];
    expect(f.verdict).toBe('confirmed');
    expect(f.npmMajor).toBe(10);
    expect(f.line).toBe(4);
    expect(f.image).toBe('node:22-alpine');
    expect(f.stage).toBe('builder');
    expect(f.manifest).toBe('package.json');
    expect(f.lockfile).toBe(false);
    expect(f.masked).toBe(false);
    const c = capture();
    expect(run([dir], c.io)).toBe(1);
  });

  it('does not flag npm ci with a copied lockfile', () => {
    const dir = mkRepo({
      Dockerfile: dockerfile([
        'FROM node:22-alpine AS builder',
        'WORKDIR /app',
        'COPY package.json package-lock.json ./',
        'RUN npm ci',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(scanRepo(dir).findings).toEqual([]);
    expect(run([dir], capture().io)).toBe(0);
  });

  it('does not flag npm install when a glob copies a lockfile present in the context', () => {
    const r = scan({
      Dockerfile: incidentWith({}).replace('COPY package.json ./', 'COPY package*.json ./'),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toEqual([]);
  });

  it('flags a glob copy when the lockfile does not exist in the context', () => {
    const r = scan({
      Dockerfile: incidentWith({}).replace('COPY package.json ./', 'COPY package*.json ./'),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].verdict).toBe('confirmed');
  });

  it('does not flag a global-only npm install (no project install)', () => {
    const r = scan({
      Dockerfile: incidentWith({ install: 'RUN npm install -g npm@11' }),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toEqual([]);
  });

  it('does not flag npm install <pkg>', () => {
    const r = scan({
      Dockerfile: incidentWith({ install: 'RUN npm install lodash' }),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toEqual([]);
  });

  it('does not flag a manifest without coverage-v8', () => {
    const r = scan({ Dockerfile: INCIDENT, 'package.json': PLAIN_PKG });
    expect(r.findings).toEqual([]);
  });

  it('finds coverage-v8 in dependencies and optionalDependencies too', () => {
    for (const key of ['dependencies', 'optionalDependencies']) {
      const r = scan({
        Dockerfile: INCIDENT,
        'package.json': JSON.stringify({ [key]: { '@vitest/coverage-v8': '^4' } }),
      });
      expect(r.findings).toHaveLength(1);
    }
  });

  it('does not flag FROM node:24-alpine (npm 11)', () => {
    const r = scan({
      Dockerfile: incidentWith({ from: 'FROM node:24-alpine' }),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toEqual([]);
  });

  it('does not flag when npm@11 is installed globally before the install', () => {
    for (const ref of ['npm@11', 'npm@^11', 'npm@11.2.0']) {
      const r = scan({
        Dockerfile: incidentWith({ extraBeforeInstall: [`RUN npm install -g ${ref}`] }),
        'package.json': COVERAGE_PKG,
      });
      expect(r.findings).toEqual([]);
    }
  });

  it('uses the overriding npm major below 11', () => {
    const r = scan({
      Dockerfile: incidentWith({ extraBeforeInstall: ['RUN npm i -g npm@9'] }),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].verdict).toBe('confirmed');
    expect(r.findings[0].npmMajor).toBe(9);
  });

  it('treats npm@latest as an unknown builder', () => {
    const r = scan({
      Dockerfile: incidentWith({ extraBeforeInstall: ['RUN npm install -g npm@latest'] }),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings[0].verdict).toBe('unknown-builder');
    expect(r.findings[0].npmMajor).toBeNull();
  });
});

describe('masking', () => {
  it('reports --legacy-peer-deps as masked, not counted, exit 0', () => {
    const dir = mkRepo({
      Dockerfile: incidentWith({ install: 'RUN npm install --legacy-peer-deps' }),
      'package.json': COVERAGE_PKG,
    });
    const report = scanRepo(dir);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].masked).toBe(true);
    expect(report.findings[0].verdict).toBe('masked');
    const c = capture();
    expect(run(['--json', dir], c.io)).toBe(0);
    expect(JSON.parse(c.out[0]).summary.findings).toBe(0);
  });

  it('reports ENV npm_config_legacy_peer_deps=true as masked, exit 0', () => {
    for (const env of ['ENV npm_config_legacy_peer_deps=true', 'ENV npm_config_legacy_peer_deps true']) {
      const dir = mkRepo({
        Dockerfile: incidentWith({ extraBeforeInstall: [env] }),
        'package.json': COVERAGE_PKG,
      });
      const report = scanRepo(dir);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].masked).toBe(true);
      expect(run([dir], capture().io)).toBe(0);
    }
  });
});

describe('lockfile detection edge cases', () => {
  it('flags --no-package-lock even though the lockfile was copied', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY package.json package-lock.json ./',
        'RUN npm install --no-package-lock',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].verdict).toBe('confirmed');
    expect(r.findings[0].lockfile).toBe(true);
    expect(r.findings[0].reason).toBe('lockfile bypassed: --no-package-lock, npm 10 < 11');
    expect(formatHuman([r])).toContain('lockfile bypassed: --no-package-lock');
  });

  it('flags an earlier rm of the lockfile', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY package.json package-lock.json ./',
        'RUN rm package-lock.json && npm install',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toHaveLength(1);
  });

  it('flags COPY . . without a lockfile in the context', () => {
    const r = scan({
      Dockerfile: dockerfile(['FROM node:22-alpine', 'COPY . .', 'RUN npm install']),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].manifest).toBe('package.json');
  });

  it('does not flag COPY . . with a lockfile in the context', () => {
    const r = scan({
      Dockerfile: dockerfile(['FROM node:22-alpine', 'COPY . .', 'RUN npm install']),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toEqual([]);
  });

  it('ignores a lockfile copied after the install and a COPY --from', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY --from=other /app/package-lock.json ./',
        'COPY package.json ./',
        'RUN npm install',
        'COPY package-lock.json ./',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toHaveLength(1);
  });
});

describe('unknown builders and stages', () => {
  it('gives unknown-builder for node:lts, node:${V} and non-node images, exit 1', () => {
    for (const from of ['FROM node:lts', 'FROM node:${V}', 'FROM ubuntu:24.04']) {
      const dir = mkRepo({ Dockerfile: incidentWith({ from }), 'package.json': COVERAGE_PKG });
      const report = scanRepo(dir);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].verdict).toBe('unknown-builder');
      expect(report.findings[0].npmMajor).toBeNull();
      expect(run([dir], capture().io)).toBe(1);
    }
  });

  it('maps node tags to npm majors per the table', () => {
    expect(npmMajorForImage('node:14')).toBe(6);
    expect(npmMajorForImage('node:16-slim')).toBe(8);
    expect(npmMajorForImage('node:18.19.0-bookworm')).toBe(10);
    expect(npmMajorForImage('docker.io/library/node:20-alpine')).toBe(10);
    expect(npmMajorForImage('node:22')).toBe(10);
    expect(npmMajorForImage('node:24-alpine')).toBe(11);
    expect(npmMajorForImage('node:26')).toBe(11);
    expect(npmMajorForImage('node:latest')).toBeNull();
    expect(npmMajorForImage('node')).toBeNull();
    expect(npmMajorForImage('node@sha256:abcdef')).toBeNull();
    expect(npmMajorForImage('node:21')).toBeNull();
  });

  it('inherits the image and npm major from an earlier stage alias', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine AS base',
        'FROM base AS build',
        'COPY package.json ./',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].verdict).toBe('confirmed');
    expect(r.findings[0].npmMajor).toBe(10);
    expect(r.findings[0].stage).toBe('build');
    expect(r.findings[0].image).toBe('node:22-alpine');
  });

  it('inherits an npm@11 upgrade from the base stage', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine AS base',
        'RUN npm install -g npm@11',
        'FROM base',
        'COPY package.json ./',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toEqual([]);
  });
});

describe('parsing', () => {
  it('reports the line where a continued RUN starts', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY package.json ./',
        '# a comment',
        'RUN apk add git \\',
        '    && npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].line).toBe(4);
  });

  it('finds the install inside sh -c', () => {
    const r = scan({
      Dockerfile: dockerfile(['FROM node:22-alpine', 'COPY package.json ./', 'RUN sh -c "npm install"']),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
  });

  it('analyzeDockerfile works on a context directory directly', () => {
    const dir = mkRepo({ 'package.json': COVERAGE_PKG });
    const r = analyzeDockerfile(INCIDENT, dir);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].dockerfile).toBe('Dockerfile');
    expect(r.warnings).toEqual([]);
  });
});

describe('repo scanning', () => {
  it('scans several Dockerfiles in one repo and flags only the bad one', () => {
    const r = scan({
      Dockerfile: dockerfile(['FROM node:24-alpine', 'COPY package.json ./', 'RUN npm install']),
      'package.json': COVERAGE_PKG,
      'backend/Dockerfile': INCIDENT,
      'backend/package.json': COVERAGE_PKG,
      'node_modules/dep/Dockerfile': INCIDENT,
    });
    expect(r.dockerfiles).toEqual(['Dockerfile', 'backend/Dockerfile']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].dockerfile).toBe('backend/Dockerfile');
    expect(r.findings[0].manifest).toBe('backend/package.json');
  });

  it('picks up Dockerfile.* and *.Dockerfile names', () => {
    const r = scan({
      'Dockerfile.prod': INCIDENT,
      'web.Dockerfile': INCIDENT,
      'notes.txt': 'x',
      'package.json': COVERAGE_PKG,
    });
    expect(r.dockerfiles).toEqual(['Dockerfile.prod', 'web.Dockerfile']);
    expect(r.findings).toHaveLength(2);
  });

  it('handles two repo arguments in one run call', () => {
    const bad = mkRepo({ Dockerfile: INCIDENT, 'package.json': COVERAGE_PKG });
    const good = mkRepo({ Dockerfile: INCIDENT, 'package.json': PLAIN_PKG });
    const c = capture();
    expect(run(['--json', good, bad], c.io)).toBe(1);
    const parsed = JSON.parse(c.out[0]);
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.repos[0].findings).toEqual([]);
    expect(parsed.repos[1].findings).toHaveLength(1);
    expect(parsed.summary.findings).toBe(1);
  });

  it('warns on a broken package.json and raises no finding', () => {
    const dir = mkRepo({ Dockerfile: INCIDENT, 'package.json': '{ not json' });
    const report = scanRepo(dir);
    expect(report.findings).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('invalid JSON');
    const c = capture();
    expect(run([dir], c.io)).toBe(0);
    expect(c.out[0]).toContain('warning');
  });

  it('exits 0 with empty findings for a repo without a Dockerfile', () => {
    const dir = mkRepo({ 'package.json': COVERAGE_PKG });
    const report = scanRepo(dir);
    expect(report.dockerfiles).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(run([dir], capture().io)).toBe(0);
  });
});

describe('CLI', () => {
  it('returns 2 without arguments', () => {
    const c = capture();
    expect(run([], c.io)).toBe(2);
    expect(c.err.join('\n')).toContain('Usage');
  });

  it('returns 2 for a missing directory, a file and an unknown option', () => {
    expect(run(['/does/not/exist'], capture().io)).toBe(2);
    const dir = mkRepo({ 'a.txt': 'x' });
    expect(run([path.join(dir, 'a.txt')], capture().io)).toBe(2);
    expect(run(['--bogus', dir], capture().io)).toBe(2);
  });

  it('prints the documented JSON structure with --json', () => {
    const dir = mkRepo({ Dockerfile: INCIDENT, 'package.json': COVERAGE_PKG });
    const c = capture();
    expect(run(['--json', dir], c.io)).toBe(1);
    const parsed = JSON.parse(c.out.join('\n'));
    expect(Object.keys(parsed).sort()).toEqual(['repos', 'summary']);
    expect(parsed.repos[0].repo).toBe(dir);
    expect(parsed.repos[0].dockerfiles).toEqual(['Dockerfile']);
    expect(parsed.repos[0].warnings).toEqual([]);
    expect(parsed.repos[0].findings[0]).toEqual({
      dockerfile: 'Dockerfile',
      stage: 'builder',
      line: 4,
      verdict: 'confirmed',
      image: 'node:22-alpine',
      npmMajor: 10,
      manifest: 'package.json',
      lockfile: false,
      masked: false,
      reason: 'lockfile-less install, npm 10 < 11',
    });
    expect(parsed.summary.findings).toBe(1);
  });

  it('names Dockerfile, line and verdict in human output', () => {
    const dir = mkRepo({ Dockerfile: INCIDENT, 'package.json': COVERAGE_PKG });
    const c = capture();
    expect(run([dir], c.io)).toBe(1);
    const text = c.out.join('\n');
    expect(text).toContain(`${dir}/Dockerfile:4 [confirmed]`);
    expect(text).toContain('npm 10');
    expect(text.endsWith('1 finding(s)')).toBe(true);
    expect(formatHuman([scanRepo(dir)])).toBe(text);
  });

  it('prints usage and known limits for --help, exit 0', () => {
    const c = capture();
    expect(run(['--help'], c.io)).toBe(0);
    expect(c.out.join('\n').toLowerCase()).toContain('known limits');
  });
});

describe('RUN flags, heredocs, shell keywords and subshells', () => {
  const installWith = (run: string, extra: string[] = []) =>
    dockerfile(['FROM node:22-alpine', 'COPY package.json ./', ...extra, run]);

  it('ignores leading RUN flags such as --mount and --network', () => {
    for (const run of [
      'RUN --mount=type=cache,target=/root/.npm npm install',
      'RUN --network=host npm install',
      'RUN --security=insecure --network=none npm install',
    ]) {
      const r = scan({ Dockerfile: installWith(run), 'package.json': COVERAGE_PKG });
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].line).toBe(3);
    }
  });

  it('reads a RUN heredoc body as the RUN shell text at the RUN start line', () => {
    for (const open of ['RUN <<EOF', 'RUN <<-EOF', "RUN <<'EOF'", 'RUN <<"EOF"', 'RUN --network=host <<EOF']) {
      const r = scan({
        Dockerfile: dockerfile(['FROM node:22-alpine', 'COPY package.json ./', open, 'set -e', 'npm install', 'EOF']),
        'package.json': COVERAGE_PKG,
      });
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].line).toBe(3);
    }
  });

  it('does not turn heredoc body lines into instructions', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:24-alpine',
        'COPY package.json ./',
        'RUN <<EOF',
        'FROM node:22-alpine',
        'COPY package.json ./',
        'EOF',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toEqual([]);
  });

  it('keeps parsing after a heredoc ends', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY package.json ./',
        'RUN <<EOF',
        'echo hi',
        'EOF',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].line).toBe(6);
  });

  it('finds the install behind then/else/do and a negation', () => {
    const cond = 'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi';
    const r = scan({
      Dockerfile: dockerfile(['FROM node:22-alpine', 'COPY . .', cond]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].line).toBe(3);
    for (const run of ['RUN true; then npm install', 'RUN for d in a; do npm install; done', 'RUN ! npm install']) {
      expect(scan({ Dockerfile: installWith(run), 'package.json': COVERAGE_PKG }).findings).toHaveLength(1);
    }
  });

  it('does not flag the if/else install when a lockfile is in the context', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY . .',
        'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toEqual([]);
  });

  it('finds the install inside a subshell or group', () => {
    for (const run of ['RUN (cd /app && npm install)', 'RUN { cd /app && npm install; }']) {
      const r = scan({ Dockerfile: installWith(run), 'package.json': COVERAGE_PKG });
      expect(r.findings).toHaveLength(1);
    }
  });

  it('splits RUN text on newlines', () => {
    const r = scan({
      Dockerfile: installWith('RUN <<EOF\ncd /app\nnpm install\nEOF'),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
  });
});

describe('npm argument parsing', () => {
  const withRun = (run: string) =>
    scan({
      Dockerfile: dockerfile(['FROM node:22-alpine', 'COPY package.json ./', run]),
      'package.json': COVERAGE_PKG,
    });

  it('lets value-taking flags consume their next token', () => {
    for (const run of [
      'RUN npm install --omit dev',
      'RUN npm install --include dev',
      'RUN npm install --prefix /app',
      'RUN npm install -C /app',
      'RUN npm install --loglevel verbose',
      'RUN npm install --cache /tmp/c',
      'RUN npm install --registry https://r.example',
      'RUN npm install --workspace web',
      'RUN npm install -w web',
    ]) {
      expect(withRun(run).findings, run).toHaveLength(1);
    }
  });

  it('accepts global options before the subcommand', () => {
    expect(withRun('RUN npm --prefix /app install').findings).toHaveLength(1);
    expect(withRun('RUN npm -C /app i').findings).toHaveLength(1);
    expect(withRun('RUN npm --legacy-peer-deps install').findings[0].masked).toBe(true);
  });

  it('treats npm install . as a project install but a package name as not', () => {
    expect(withRun('RUN npm install .').findings).toHaveLength(1);
    expect(withRun('RUN npm install ./').findings).toHaveLength(1);
    expect(withRun('RUN npm install --omit dev lodash').findings).toEqual([]);
  });

  it('treats a bare npm i -g npm as latest, an unknown builder', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'RUN npm i -g npm',
        'COPY package.json ./',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].verdict).toBe('unknown-builder');
    expect(r.findings[0].npmMajor).toBeNull();
  });
});

describe('rm bypass matching', () => {
  it('matches the basename: an unrelated file ending in package-lock.json is no bypass', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY package*.json ./',
        'RUN rm -rf /tmp/old-package-lock.json && npm install',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toEqual([]);
  });

  it('still treats rm of a path to the lockfile as a bypass', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY package*.json ./',
        'RUN rm -f /app/package-lock.json && npm install',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].reason).toContain('lockfile bypassed: rm package-lock.json');
  });
});

describe('stage inheritance of manifests and lockfile state', () => {
  it('inherits copied manifests from the parent stage', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine AS deps',
        'COPY package.json ./',
        'FROM deps AS build',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].stage).toBe('build');
    expect(r.findings[0].manifest).toBe('package.json');
  });

  it('inherits a copied lockfile from the parent stage', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine AS deps',
        'COPY package.json package-lock.json ./',
        'FROM deps AS build',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toEqual([]);
  });

  it('inherits a lockfile removal from the parent stage', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine AS deps',
        'COPY package*.json ./',
        'RUN rm package-lock.json',
        'FROM deps AS build',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
      'package-lock.json': '{}',
    });
    expect(r.findings).toHaveLength(1);
  });

  it('masks a child stage when the base stage sets the legacy-peer-deps ENV', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine AS base',
        'ENV npm_config_legacy_peer_deps=true',
        'FROM base',
        'COPY package.json ./',
        'RUN npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].masked).toBe(true);
  });
});

describe('masking, unknown builders and comments (extra fixtures)', () => {
  it('masks an env-prefixed install npm_config_legacy_peer_deps=true npm install', () => {
    const r = scan({
      Dockerfile: incidentWith({ install: 'RUN npm_config_legacy_peer_deps=true npm install' }),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].masked).toBe(true);
    expect(r.findings[0].verdict).toBe('masked');
  });

  it('gives unknown-builder for a variable after a node major (node:22-${V})', () => {
    const r = scan({
      Dockerfile: incidentWith({ from: 'FROM node:22-${V}' }),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].verdict).toBe('unknown-builder');
    expect(r.findings[0].reason).toContain('unknown builder');
    expect(npmMajorForImage('node:22-${V}')).toBeNull();
  });

  it('keeps the RUN start line when a comment line sits inside the continuation', () => {
    const r = scan({
      Dockerfile: dockerfile([
        'FROM node:22-alpine',
        'COPY package.json ./',
        'RUN apk add git \\',
        '# note inside the continuation',
        '    && npm install',
      ]),
      'package.json': COVERAGE_PKG,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].line).toBe(3);
  });
});

describe('repo walk', () => {
  it('skips .worktrees directories next to node_modules and .git', () => {
    const r = scan({
      'Dockerfile': dockerfile(['FROM node:24-alpine']),
      '.worktrees/feature/Dockerfile': INCIDENT,
      '.worktrees/feature/package.json': COVERAGE_PKG,
      'sub/.worktrees/x/Dockerfile': INCIDENT,
    });
    expect(r.dockerfiles).toEqual(['Dockerfile']);
    expect(r.findings).toEqual([]);
  });
});
