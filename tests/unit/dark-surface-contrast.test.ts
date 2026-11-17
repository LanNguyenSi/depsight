// The UI is dark only. Secondary text on the dark surfaces uses gray-400 at
// the dimmest: gray-500 and gray-600 (and gray-700) fall below the 4.5:1 AA
// contrast ratio on gray-900/950 and gray-800, and a text block dimmed with
// `opacity-*` loses contrast the same way. The scan below keeps those classes
// out of `app/` and `components/`. A blanket rule is sound only while no light
// surface exists, so a second test pins that too (a light card would make
// gray-500 text legitimate there, and this test must then be revisited).
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
const DIM_TEXT = /(?<![\w-])(?:[\w[\]-]+:)*text-gray-(?:500|600|700)(?![\w-])/g;
/** Text dimmed through opacity instead of colour (the severity tile labels). */
const OPACITY_TEXT = /(?<![\w-])opacity-70(?![\w-])/g;
/** A state switched on by a bare `'opacity-30'` literal (`active ? '' : 'opacity-30'`): the label then loses contrast. */
const DIMMED_TOGGLE = /'opacity-\d+'/g;
/** Light surfaces. `bg-white` is the switch knob, handled below. */
const LIGHT_SURFACE = /(?<![\w-])(?:[\w[\]-]+:)*bg-(?:white|gray-(?:50|100|200|300)|slate-(?:50|100|200|300))(?![\w-])/g;

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

  it('uses no text-gray-500, text-gray-600 or text-gray-700', () => {
    expect(hits(DIM_TEXT)).toEqual([]);
  });

  it('dims no text with opacity-70', () => {
    expect(hits(OPACITY_TEXT)).toEqual([]);
  });

  it('dims no state through a bare opacity literal', () => {
    expect(hits(DIMMED_TOGGLE)).toEqual([]);
  });

  it('has no light surface, so the rule above has no legitimate exception', () => {
    // The one white element is the 16 px knob of the policy switch.
    expect(hits(LIGHT_SURFACE)).toEqual(['components/PolicyList.tsx:429 bg-white']);
  });

  it('detects the classes it forbids (the scan is not inert)', () => {
    const sample = 'a text-gray-500 b hover:text-gray-600 c md:text-gray-700 d text-gray-400 e text-gray-5000';
    expect([...sample.matchAll(DIM_TEXT)].map((m) => m[0])).toEqual([
      'text-gray-500',
      'hover:text-gray-600',
      'md:text-gray-700',
    ]);
    expect([...'<div className="text-[10px] opacity-70">'.matchAll(OPACITY_TEXT)]).toHaveLength(1);
    expect([..."a ? '' : 'opacity-30'".matchAll(DIMMED_TOGGLE)]).toHaveLength(1);
    expect([...'opacity-700 opacity-7'.matchAll(OPACITY_TEXT)]).toHaveLength(0);
    expect([...'x bg-white y bg-gray-100 z bg-gray-900'.matchAll(LIGHT_SURFACE)]).toHaveLength(2);
  });
});
