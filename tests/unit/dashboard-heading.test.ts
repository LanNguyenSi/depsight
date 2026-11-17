// /dashboard must expose exactly one level-one heading with the page title, so
// the page passes the axe page-has-heading-one rule.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => ({ get: () => null }),
}));
vi.mock('@/app/actions', () => ({ logout: vi.fn() }));

import { LocaleProvider } from '@/lib/i18n';
import { DashboardClient } from '@/app/dashboard/DashboardClient';

describe('DashboardClient page heading', () => {
  it('renders exactly one h1 with the page title', () => {
    const html = renderToStaticMarkup(
      createElement(
        LocaleProvider,
        { initialLocale: 'de' },
        createElement(DashboardClient, { repos: [], initialRepoId: null, ciEnabledRepoIds: [] }),
      ),
    );
    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
    expect(html).toContain('<h1 class="text-lg font-semibold text-white mb-4">Dashboard</h1>');
  });
});
