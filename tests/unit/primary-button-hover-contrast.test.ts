// Primary buttons carry white text on bg-blue-600 (5.3:1). Their hover
// colour must keep that text readable: blue-500 (#2b7fff, 3.8:1) fails AA,
// blue-700 (#1447e6, 6.8:1) passes. A scan of `app/` and `components/`
// forbids any class value that combines `text-white` with the bare
// `hover:bg-blue-500`, so the class cannot come back. Opacity-modified
// variants (`hover:bg-blue-500/30`) are not solid white-on-blue surfaces
// and are out of scope, hence the negative lookahead for `/`. The same
// holds for the destructive button: white on red-500 (#fb2c36, 3.7:1) fails
// AA, red-700 (about 6.4:1) passes, so `hover:bg-red-500` is forbidden too.
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

/** Class values of className="..." and className={`...`} attributes. */
function classValues(source: string): string[] {
  const values: string[] = [];
  for (const m of source.matchAll(/className="([^"]*)"/g)) values.push(m[1]);
  for (const m of source.matchAll(/className=\{`([^`]*)`\}/g)) values.push(m[1]);
  return values;
}

const WHITE_TEXT = /(?<![\w-])text-white(?![\w-])/;
/** `hover:bg-blue-500` as a full token, without an opacity suffix. */
const BLUE_HOVER = /(?<![\w-])hover:bg-blue-500(?![\w/-])/;

/** `hover:bg-red-500` as a full token, without an opacity suffix. */
const RED_HOVER = /(?<![\w-])hover:bg-red-500(?![\w/-])/;

/** A class value with white text and a forbidden (blue-500 or red-500) hover. */
function isOffender(cls: string): boolean {
  return WHITE_TEXT.test(cls) && (BLUE_HOVER.test(cls) || RED_HOVER.test(cls));
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8');
    classValues(source).forEach((cls, i) => {
      if (isOffender(cls)) {
        found.push(`${relative(ROOT, file)} #${i}`);
      }
    });
  }
  return found;
}

describe('primary button hover contrast', () => {
  it('scans the app and component sources', () => {
    expect(FILES.length).toBeGreaterThan(30);
    expect(FILES.some((f) => f.endsWith('app/dashboard/DashboardChrome.tsx'))).toBe(true);
  });

  it('has no class value combining text-white with hover:bg-blue-500', () => {
    expect(offenders()).toEqual([]);
  });

  it('has red-700 as the hover of the white-on-red destructive confirm button', () => {
    const modal = readFileSync(join(ROOT, 'components/ConfirmModal.tsx'), 'utf8');
    expect(modal).toContain("'bg-red-600 hover:bg-red-700'");
    expect(modal).not.toContain('hover:bg-red-500');
  });

  it('has blue-700 as the hover of white-on-blue primary buttons', () => {
    const chrome = readFileSync(join(ROOT, 'app/dashboard/DashboardChrome.tsx'), 'utf8');
    expect(chrome).toContain('bg-blue-600');
    expect(chrome).toContain('text-white');
    expect(chrome).toContain('hover:bg-blue-700');
  });

  it('detects the classes it forbids (the scan is not inert)', () => {
    expect(BLUE_HOVER.test('px-3 bg-blue-600 text-white hover:bg-blue-500 transition-colors')).toBe(true);
    expect(BLUE_HOVER.test('bg-blue-600 hover:bg-blue-500')).toBe(true);
    expect(BLUE_HOVER.test('hover:bg-blue-500/30 text-blue-300')).toBe(false);
    expect(BLUE_HOVER.test('hover:bg-blue-5000')).toBe(false);
    expect(BLUE_HOVER.test('hover:bg-blue-700')).toBe(false);
    expect(isOffender('text-white bg-red-600 hover:bg-red-500')).toBe(true);
    expect(isOffender('text-white bg-blue-600 hover:bg-blue-500')).toBe(true);
    expect(isOffender('text-white bg-red-600 hover:bg-red-700')).toBe(false);
    expect(isOffender('text-red-400 hover:bg-red-500')).toBe(false);
    expect(RED_HOVER.test('px-4 text-white bg-red-600 hover:bg-red-500')).toBe(true);
    expect(RED_HOVER.test('hover:bg-red-500/30 text-red-300')).toBe(false);
    expect(RED_HOVER.test('hover:bg-red-5000')).toBe(false);
    expect(RED_HOVER.test('hover:bg-red-700')).toBe(false);
    expect(WHITE_TEXT.test('text-white')).toBe(true);
    expect(WHITE_TEXT.test('text-white/50')).toBe(true);
    expect(WHITE_TEXT.test('text-whitex')).toBe(false);
    expect(WHITE_TEXT.test('text-gray-300')).toBe(false);
    expect(classValues('a className="text-white hover:bg-blue-500" b')).toEqual([
      'text-white hover:bg-blue-500',
    ]);
    expect(classValues('className={`text-white ${c ? "hover:bg-blue-500" : ""}`} x')).toEqual([
      'text-white ${c ? "hover:bg-blue-500" : ""}',
    ]);
  });
});
