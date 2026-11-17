// The login page does not use AppShell, so it must provide the <main>
// landmark itself (axe landmark-one-main rule).
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('@/lib/auth', () => ({ signIn: vi.fn() }));

import { renderToStaticMarkup } from 'react-dom/server';

import LoginPage from '@/app/login/page';

describe('login page landmark', () => {
  it('wraps the page in a single <main> with the original wrapper classes', async () => {
    const element = await LoginPage();
    const html = renderToStaticMarkup(element);
    expect(html.match(/<main[\s>]/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/^<main class="min-h-screen flex items-center justify-center bg-gray-950">/);
    expect(html).toContain('<h1 class="text-xl font-bold text-white">depsight</h1>');
  });
});
