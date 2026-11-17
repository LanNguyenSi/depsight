// /overview must expose exactly one level-one heading with the page title, so
// the page passes the axe page-has-heading-one rule.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/overview',
  useSearchParams: () => ({ get: () => null }),
}));
vi.mock('@/app/actions', () => ({ logout: vi.fn() }));

import { LocaleProvider } from '@/lib/i18n';
import { OverviewClient } from '@/app/overview/OverviewClient';

const data = {
  repos: [
    {
      repoId: 'r-1',
      fullName: 'acme/api',
      language: 'TypeScript',
      lastScannedAt: '2026-01-02T03:04:05.000Z',
      riskScore: 12,
      cveCount: 1,
      criticalCount: 0,
      highCount: 1,
      licenseIssues: 0,
      outdatedDeps: 2,
      totalDeps: 10,
      healthScore: 81,
    },
  ],
  aggregate: {
    totalRepos: 1,
    scannedRepos: 1,
    avgRiskScore: 12,
    totalCVEs: 1,
    totalCritical: 0,
    totalHigh: 1,
    totalLicenseIssues: 0,
    highRiskRepos: 0,
    mediumRiskRepos: 0,
    lowRiskRepos: 1,
    overallHealthScore: 81,
  },
  topRiskyRepos: [],
  mostOutdated: [],
};

describe('OverviewClient page heading', () => {
  it('renders exactly one h1 with the page title', () => {
    const html = renderToStaticMarkup(
      createElement(LocaleProvider, { initialLocale: 'de' }, createElement(OverviewClient, { data })),
    );
    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
    expect(html).toContain('<h1 class="text-lg font-semibold text-white">Übersicht</h1>');
  });
});
