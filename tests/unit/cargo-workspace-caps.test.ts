import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  collectRustDeps,
  isWorkspaceMember,
  nearestCargoLock,
  parseCargoWorkspace,
  cargoWorkspaceRegExpCompiles,
  MAX_CARGO_WORKSPACE_PATTERN_CHARS,
  MAX_CARGO_WORKSPACE_PATTERNS,
} from '@/lib/manifests/rust';

type Octokit = Parameters<typeof collectRustDeps>[0];

const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';

function octokitWith(files: Record<string, string>): Octokit {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path in files) {
      return { data: { content: Buffer.from(files[path]).toString('base64') } };
    }
    throw new Error('404');
  });
  return { rest: { repos: { getContent } } } as unknown as Octokit;
}

function pkg(name: string, version: string): string {
  return `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "${CRATES_IO}"\n`;
}

// A `[workspace]` Cargo.toml whose `members` / `exclude` are the given arrays,
// one quoted entry per line, exactly as parseCargoWorkspace reads them.
function workspaceToml(members: string[], exclude: string[]): string {
  const arr = (name: string, xs: string[]) =>
    `${name} = [\n${xs.map((x) => `  "${x}"`).join(',\n')}\n]\n`;
  let toml = '[workspace]\n';
  if (members.length) toml += arr('members', members);
  if (exclude.length) toml += arr('exclude', exclude);
  return toml;
}

// A distinct member pattern of exactly `len` characters (never `#`, `'`, `]` or
// a quote, none of which the line-based reader handles inside an entry).
function patternOfLen(len: number, i = 0): string {
  return `p${i}-${'x'.repeat(len - `p${i}-`.length)}`;
}

function patterns(count: number, len = 8): string[] {
  return Array.from({ length: count }, (_, i) => patternOfLen(len, i));
}

describe('Cargo workspace pattern caps', () => {
  it('mirrors the npm workspace matcher caps', () => {
    expect([MAX_CARGO_WORKSPACE_PATTERNS, MAX_CARGO_WORKSPACE_PATTERN_CHARS]).toEqual([1000, 1024]);
  });

  describe('exactly at the caps is modelled', () => {
    it('1000 members and 1000 exclude entries', () => {
      const ws = parseCargoWorkspace(workspaceToml(patterns(MAX_CARGO_WORKSPACE_PATTERNS), patterns(MAX_CARGO_WORKSPACE_PATTERNS)));
      expect(ws).not.toBeNull();
      expect(ws?.members).toHaveLength(MAX_CARGO_WORKSPACE_PATTERNS);
      expect(ws?.exclude).toHaveLength(MAX_CARGO_WORKSPACE_PATTERNS);
    });

    it('a member and an exclude pattern of exactly the length cap', () => {
      const long = patternOfLen(MAX_CARGO_WORKSPACE_PATTERN_CHARS);
      expect(long).toHaveLength(MAX_CARGO_WORKSPACE_PATTERN_CHARS);
      const ws = parseCargoWorkspace(workspaceToml([long], [long]));
      expect(ws).not.toBeNull();
      expect(ws?.members[0]).toHaveLength(MAX_CARGO_WORKSPACE_PATTERN_CHARS);
    });
  });

  describe('one over each cap drops the workspace', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const over = (members: string[], exclude: string[]) =>
      parseCargoWorkspace(workspaceToml(members, exclude), 'vendor/broken/Cargo.toml');

    it('members over the count cap: null plus one warning', () => {
      const ws = over(patterns(MAX_CARGO_WORKSPACE_PATTERNS + 1), []);
      expect(ws).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(vi.mocked(console.warn).mock.calls[0][0]);
      expect(msg).toContain('vendor/broken/Cargo.toml');
      expect(msg).toContain(`${MAX_CARGO_WORKSPACE_PATTERNS} members patterns`);
    });

    it('exclude over the count cap: null plus one warning', () => {
      const ws = over([], patterns(MAX_CARGO_WORKSPACE_PATTERNS + 1));
      expect(ws).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(vi.mocked(console.warn).mock.calls[0][0]);
      expect(msg).toContain(`${MAX_CARGO_WORKSPACE_PATTERNS} exclude patterns`);
    });

    it('a members pattern over the length cap: null, warning names no pattern text', () => {
      const long = patternOfLen(MAX_CARGO_WORKSPACE_PATTERN_CHARS + 1);
      const ws = over([long], []);
      expect(ws).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(vi.mocked(console.warn).mock.calls[0][0]);
      expect(msg).toContain(`members pattern longer than ${MAX_CARGO_WORKSPACE_PATTERN_CHARS} characters`);
      expect(msg).not.toContain('xxxxxxxx');
    });

    it('an exclude pattern over the length cap: null plus one warning', () => {
      const long = patternOfLen(MAX_CARGO_WORKSPACE_PATTERN_CHARS + 1);
      const ws = over([], [long]);
      expect(ws).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(vi.mocked(console.warn).mock.calls[0][0]);
      expect(msg).toContain(`exclude pattern longer than ${MAX_CARGO_WORKSPACE_PATTERN_CHARS} characters`);
    });
  });

  describe('isWorkspaceMember compiles each pattern once per workspace', () => {
    it('repeated calls on one workspace build no new RegExps after the first', () => {
      const ws = { members: ['crates/*', 'tools/cli', 'apps/*'], exclude: ['crates/old'] };
      const before = cargoWorkspaceRegExpCompiles.count;
      expect(isWorkspaceMember(ws, 'crates/a')).toBe(true);
      const afterFirst = cargoWorkspaceRegExpCompiles.count;
      expect(afterFirst - before).toBe(ws.members.length);
      for (let i = 0; i < 50; i++) {
        expect(isWorkspaceMember(ws, `apps/${i}`)).toBe(true);
      }
      expect(cargoWorkspaceRegExpCompiles.count).toBe(afterFirst);
    });

    it('a fresh workspace object compiles its patterns again', () => {
      const before = cargoWorkspaceRegExpCompiles.count;
      isWorkspaceMember({ members: ['crates/*'], exclude: [] }, 'crates/a');
      const one = cargoWorkspaceRegExpCompiles.count - before;
      isWorkspaceMember({ members: ['crates/*'], exclude: [] }, 'crates/b');
      expect(cargoWorkspaceRegExpCompiles.count - before).toBe(one * 2);
    });
  });

  it('a 1 MiB synthetic Cargo.toml resolves within the cap of RegExps', () => {
    const members = patterns(MAX_CARGO_WORKSPACE_PATTERNS, MAX_CARGO_WORKSPACE_PATTERN_CHARS);
    const toml = workspaceToml(members, []);
    expect(toml.length).toBeGreaterThan(1_000_000);
    const ws = parseCargoWorkspace(toml, 'Cargo.toml');
    expect(ws).not.toBeNull();
    const before = cargoWorkspaceRegExpCompiles.count;
    for (let i = 0; i < 400; i++) {
      isWorkspaceMember(ws!, `p${i}-yyy`);
    }
    const built = cargoWorkspaceRegExpCompiles.count - before;
    expect(built).toBeGreaterThan(0);
    expect(built).toBeLessThanOrEqual(MAX_CARGO_WORKSPACE_PATTERNS);
  }, 30_000);

  describe('an over-cap workspace falls back to the nearest lock', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('collectRustDeps uses the member lock, not the dropped workspace root lock', async () => {
      // Root lists crates/* (so it WOULD claim crates/a as a member) but carries
      // one pattern over the count cap, so parseCargoWorkspace drops it.
      const rootMembers = ['crates/*', ...patterns(MAX_CARGO_WORKSPACE_PATTERNS)];
      expect(rootMembers).toHaveLength(MAX_CARGO_WORKSPACE_PATTERNS + 1);
      const oct = octokitWith({
        'Cargo.toml': workspaceToml(rootMembers, []),
        'Cargo.lock': pkg('serde', '1.0.0'),
        'crates/a/Cargo.toml': `[dependencies]\nserde = "1"\n`,
        'crates/a/Cargo.lock': pkg('serde', '1.5.0'),
      });
      const deps = await collectRustDeps(oct, 'o', 'r', ['Cargo.toml', 'crates/a/Cargo.toml']);
      // Modelled, crates/a is a member and resolves against the root lock (1.0.0);
      // dropped, it keeps its own nearest lock (1.5.0). Both satisfy "1".
      expect(deps).toEqual([{ name: 'serde', version: '1.5.0' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain('Cargo.toml');
    });

    it('a within-cap workspace still claims the member (root lock wins)', async () => {
      const oct = octokitWith({
        'Cargo.toml': workspaceToml(['crates/*'], []),
        'Cargo.lock': pkg('serde', '1.0.0'),
        'crates/a/Cargo.toml': `[dependencies]\nserde = "1"\n`,
        'crates/a/Cargo.lock': pkg('serde', '1.5.0'),
      });
      const deps = await collectRustDeps(oct, 'o', 'r', ['Cargo.toml', 'crates/a/Cargo.toml']);
      expect(deps).toEqual([{ name: 'serde', version: '1.0.0' }]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('nearestCargoLock walks to the nearest lock when the workspace is dropped', () => {
      // A dropped (over-cap) workspace is absent from the map, so the walk is used.
      const locks = new Set(['Cargo.lock', 'crates/a/Cargo.lock']);
      expect(nearestCargoLock('crates/a/Cargo.toml', locks, new Map())).toBe('crates/a/Cargo.lock');
    });
  });
});
