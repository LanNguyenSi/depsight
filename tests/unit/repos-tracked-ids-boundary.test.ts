// Boundary pin: the cheap tracked-ids leg (lib/repos/tracked-ids.ts and its
// route) must stay cheap. Neither file may import anything from
// lib/overview -- that would reintroduce a path into
// getTeamHealthOverview's full aggregation, the exact cost this endpoint
// exists to avoid. Reads the source text directly rather than mocking, so
// the pin holds regardless of how the module graph is bundled.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  'lib/repos/tracked-ids.ts',
  'app/api/repos/tracked-ids/route.ts',
];

describe('tracked-ids boundary: no import from lib/overview', () => {
  for (const relativePath of FILES) {
    it(`${relativePath} imports nothing from lib/overview`, () => {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
      const overviewImport = /from\s+['"]@?\/?lib\/overview/;
      expect(overviewImport.test(source)).toBe(false);
    });
  }
});
