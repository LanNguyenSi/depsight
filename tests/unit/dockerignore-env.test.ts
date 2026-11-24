import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// The build context must never carry an env file: `.env.*` does not match
// `.env` itself, so both patterns have to stay.
const lines = readFileSync(resolve(__dirname, '../../.dockerignore'), 'utf8')
  .split('\n')
  .map((l) => l.trim());

describe('.dockerignore', () => {
  it.each(['.env', '.env.*'])('excludes %s', (pattern) => {
    expect(lines).toContain(pattern);
  });

  it('does not re-include an env file', () => {
    expect(lines.filter((l) => l.startsWith('!.env'))).toEqual([]);
  });
});
