// The new-policy form on /policies is behind a client toggle, so its markup
// is not reachable through renderToStaticMarkup (showForm starts false). This
// test pins the pairing rule on the source: every form control id has a
// label with the matching htmlFor, and every htmlFor points at a control.
// The rendered accessible name (axe select-name and label = 0 with the form
// open) is proven in the browser check.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(__dirname, '../../components/PolicyList.tsx'), 'utf8');

function htmlForIds(): string[] {
  return [...SOURCE.matchAll(/htmlFor="([^"]+)"/g)].map((m) => m[1]);
}

function controlIds(): string[] {
  return [...SOURCE.matchAll(/\bid="(policy-form-[^"]+)"/g)].map((m) => m[1]);
}

describe('PolicyList new-policy form labels', () => {
  it('gives every control id a label with the matching htmlFor', () => {
    const ids = controlIds();
    expect(ids.length).toBeGreaterThanOrEqual(9);
    expect(htmlForIds().sort()).toEqual([...ids].sort());
  });

  it('labels the two always-visible selects', () => {
    const pairs = htmlForIds();
    expect(pairs).toContain('policy-form-type');
    expect(pairs).toContain('policy-form-severity');
    expect(SOURCE).toMatch(/<label htmlFor="policy-form-type"[^>]*>\{t\['policy\.form\.type'\]\}<\/label>/);
    expect(SOURCE).toMatch(/<label htmlFor="policy-form-severity"[^>]*>\{t\['policy\.form\.severity'\]\}<\/label>/);
  });

  it('has no bare label element left in the form', () => {
    expect(SOURCE).not.toMatch(/<label className=\{labelCls\}>/);
  });
});
