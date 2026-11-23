// A grey text input on bg-gray-900 that drops the browser outline must still
// show a visible focus indicator: a ring (focus-visible:ring-2, blue-500
// against gray-900 is above 3:1) or a blue-500 border.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = [
  'app/settings/SettingsClient.tsx',
  'app/dashboard/DashboardClient.tsx',
  'components/DependencyTable.tsx',
  'components/LicenseList.tsx',
  'components/AdvisoryList.tsx',
  'components/PolicyList.tsx',
  'components/PRScanButton.tsx',
  'app/login/page.tsx',
];

function classStrings(src: string): string[] {
  // Every quoted string (single, double, template) containing focus:outline-none.
  return (src.match(/(['"`])(?:(?!\1)[^\n])*focus:outline-none(?:(?!\1)[^\n])*\1/g) ?? []);
}

describe('inputs that remove the outline keep a visible focus indicator', () => {
  let sites = 0;
  for (const file of FILES) {
    const src = readFileSync(resolve(__dirname, '../..', file), 'utf8');
    for (const cls of classStrings(src)) {
      sites += 1;
      it(`${file}: ${cls.slice(0, 60)}...`, () => {
        expect(cls).toMatch(/focus-visible:ring-2|focus:border-blue-500/);
        if (cls.includes('focus-visible:ring-2')) expect(cls).toContain('focus-visible:ring-blue-500');
      });
    }
  }
  it('found every known site (at least nine)', () => {
    expect(sites).toBeGreaterThanOrEqual(9);
  });
});
