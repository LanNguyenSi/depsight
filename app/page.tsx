export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { cookies } from 'next/headers';
import { getTranslations, type Locale } from '@/lib/i18n/translations';
import Link from 'next/link';

export default async function HomePage() {
  const session = await auth();
  if (session?.user) redirect('/overview');

  const cookieStore = await cookies();
  const locale = (cookieStore.get('locale')?.value as Locale) || 'de';
  const t = getTranslations(locale);

  const FEATURES = [
    { title: t['landing.feature.cveScan'], description: t['landing.feature.cveScanDesc'], color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' },
    { title: t['landing.feature.license'], description: t['landing.feature.licenseDesc'], color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20' },
    { title: t['landing.feature.depHealth'], description: t['landing.feature.depHealthDesc'], color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20' },
    { title: t['landing.feature.multiEco'], description: t['landing.feature.multiEcoDesc'], color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20' },
    { title: t['landing.feature.teamOverview'], description: t['landing.feature.teamOverviewDesc'], color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
    { title: t['landing.feature.policyEngine'], description: t['landing.feature.policyEngineDesc'], color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/20' },
  ];

  return (
    <main className="min-h-screen bg-gray-950">
      <div className="max-w-5xl mx-auto px-6 pt-24 pb-16">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-8">
            <svg viewBox="0 0 24 24" className="w-7 h-7 text-white fill-current">
              <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16zm0 3a1 1 0 00-1 1v3.586l-2.707 2.707a1 1 0 001.414 1.414l3-3A1 1 0 0013 12V8a1 1 0 00-1-1z" />
            </svg>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white tracking-tight mb-4">depsight</h1>
          <p className="text-xl text-gray-400 mb-2">{t['landing.subtitle']}</p>
          <p className="text-sm text-gray-500 max-w-md mx-auto mb-10">{t['landing.description']}</p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 px-8 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 transition-colors text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {t['landing.cta']}
          </Link>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className={`rounded-xl border p-5 ${f.bg}`}>
              <h3 className={`text-sm font-semibold mb-1.5 ${f.color}`}>{f.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <p className="text-xs text-gray-600 uppercase tracking-widest mb-3">{t['landing.ecosystems']}</p>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-500">
            {['npm', 'Python', 'Go', 'Java', 'Rust', 'PHP'].map((e) => (
              <span key={e} className="font-mono">{e}</span>
            ))}
          </div>
        </div>
      </div>

      <footer className="border-t border-gray-800 py-6">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between text-xs text-gray-600">
          <span>depsight</span>
          <div className="flex items-center gap-4">
            <span>{t['landing.footer']}</span>
            <a
              href="https://github.com/LanNguyenSi/depsight"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-400 transition-colors"
              aria-label="GitHub"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
