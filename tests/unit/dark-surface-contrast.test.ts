// The UI is dark only. Secondary text on the dark surfaces uses gray-400 at
// the dimmest: gray-500, gray-600 and gray-700 (text and placeholder) fall
// below the 4.5:1 AA contrast ratio on gray-900/950 and gray-800. A state
// dimmed with an `opacity-<n>` class loses contrast the same way, so the scan
// below forbids every `opacity-<n>` class token that has no variant prefix
// (`disabled:opacity-50` is fine: WCAG exempts inactive controls) apart from a
// short allowlist of graphics. It reads class tokens in `app/` and
// `components/` sources; it does not resolve classes built from string pieces
// at run time (none exist today). A blanket rule is sound only while no light
// surface exists, so a test pins that too (a light card would make gray-500
// text legitimate there, and this test must then be revisited).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const FILES = [...tsxFiles(join(ROOT, 'app')), ...tsxFiles(join(ROOT, 'components'))];

/** Classes that are too dim on a dark surface; `hover:` and other variants count. */
const DIM_TEXT = /(?<![\w-])(?:[\w[\]-]+:)*(?:text|placeholder)-gray-(?:500|600|700)(?![\w-])/g;
/** An `opacity-<n>` class without a variant prefix (it is on at all times). */
const OPACITY = /(?<![\w:-])opacity-\d+(?![\w-])/g;
/** Light surfaces. `bg-white` is the switch knob, handled below. */
const LIGHT_SURFACE = /(?<![\w-])(?:[\w[\]-]+:)*bg-(?:white|gray-(?:50|100|200|300)|slate-(?:50|100|200|300))(?![\w-])/g;

/** Opacity that is not text: each entry must match a real site, or the test fails. */
const OPACITY_ALLOWLIST = [
  { file: 'app/dashboard/DashboardClient.tsx', token: 'opacity-25', reason: 'track of the SVG spinner, a graphic' },
  { file: 'app/dashboard/DashboardClient.tsx', token: 'opacity-75', reason: 'arc of the SVG spinner, a graphic' },
];

function hits(re: RegExp): string[] {
  const found: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(re)) found.push(`${relative(ROOT, file)}:${i + 1} ${m[0]}`);
    });
  }
  return found;
}

describe('dark surface contrast', () => {
  it('scans the app and component sources', () => {
    expect(FILES.length).toBeGreaterThan(30);
    expect(FILES.some((f) => f.endsWith('components/AdvisoryList.tsx'))).toBe(true);
    expect(FILES.some((f) => f.endsWith('app/dashboard/DashboardClient.tsx'))).toBe(true);
  });

  it('uses no text-gray-500/600/700 and no placeholder-gray-500/600/700', () => {
    expect(hits(DIM_TEXT)).toEqual([]);
  });

  it('keeps no opacity class on at all times, apart from the allowlisted graphics', () => {
    const found = hits(OPACITY).filter((h) => {
      const [where, token] = h.split(' ');
      return !OPACITY_ALLOWLIST.some((a) => where.startsWith(`${a.file}:`) && token === a.token);
    });
    expect(found).toEqual([]);
  });

  it('has no stale opacity allowlist entry', () => {
    const found = hits(OPACITY);
    for (const a of OPACITY_ALLOWLIST) {
      expect(found.some((h) => h.startsWith(`${a.file}:`) && h.endsWith(` ${a.token}`)), `${a.file} ${a.token}`).toBe(true);
    }
  });

  it('has no light surface, so the rules above have no legitimate exception', () => {
    // The one white element is the 16 px knob of the policy switch.
    expect(hits(LIGHT_SURFACE)).toEqual(['components/PolicyList.tsx:438 bg-white']);
  });

  it('detects the classes it forbids (the scan is not inert)', () => {
    const sample =
      'a text-gray-500 b hover:text-gray-600 c md:text-gray-700 d text-gray-400 e text-gray-5000 f placeholder-gray-600 g placeholder-gray-400';
    expect([...sample.matchAll(DIM_TEXT)].map((m) => m[0])).toEqual([
      'text-gray-500',
      'hover:text-gray-600',
      'md:text-gray-700',
      'placeholder-gray-600',
    ]);
    const opacity = (x: string) => [...x.matchAll(OPACITY)].map((m) => m[0]);
    expect(opacity('opacity-70 opacity-60 disabled:opacity-30 hover:opacity-50 group-hover:opacity-20')).toEqual([
      'opacity-70',
      'opacity-60',
    ]);
    expect(opacity("a ? '' : 'opacity-30'")).toEqual(['opacity-30']);
    expect(opacity('opacity-60 disabled:opacity-30')).toEqual(['opacity-60']);
    expect(opacity('text-opacity-50 bg-opacity-50 opacity-x')).toEqual([]);
    expect([...'x bg-white y bg-gray-100 z bg-gray-900'.matchAll(LIGHT_SURFACE)]).toHaveLength(2);
  });
});
