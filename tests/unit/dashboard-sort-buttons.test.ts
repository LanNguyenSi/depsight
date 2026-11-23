import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTranslations } from '@/lib/i18n/translations';

// DashboardClient is too heavy to render in the node test environment, so the
// sort group is checked at source level (the way touch-targets.test.ts reads
// the same file); the browser check reads the live state.
const src = readFileSync(resolve(__dirname, '../../app/dashboard/DashboardClient.tsx'), 'utf8');
const group = src.slice(src.indexOf('<div role="group" aria-label={t[\'dashboard.sort.label\']}'));
const groupBlock = group.slice(0, group.indexOf('</div>'));

describe('dashboard sort buttons', () => {
  it('expose the active sort as aria-pressed, not only by colour', () => {
    expect(groupBlock).toContain('aria-pressed={sortBy === key}');
  });

  it('sit in a named group', () => {
    expect(src).toContain('<div role="group" aria-label={t[\'dashboard.sort.label\']}');
  });

  it('have a group label in both locales', () => {
    expect(getTranslations('de')['dashboard.sort.label']).toBe('Sortierung');
    expect(getTranslations('en')['dashboard.sort.label']).toBe('Sort by');
  });
});
