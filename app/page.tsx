export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import Link from 'next/link';

const FEATURES = [
  {
    title: 'CVE-Scanning',
    description: 'Erkennt bekannte Schwachstellen in allen Dependencies über GitHub Dependabot.',
    color: 'text-red-400',
    bg: 'bg-red-500/10 border-red-500/20',
  },
  {
    title: 'Lizenz-Compliance',
    description: 'Prüft Lizenzen auf Copyleft-Konflikte und Policy-Verstöße automatisch.',
    color: 'text-purple-400',
    bg: 'bg-purple-500/10 border-purple-500/20',
  },
  {
    title: 'Dependency Health',
    description: 'Zeigt veraltete, deprecated und major-behind Abhängigkeiten auf.',
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/20',
  },
  {
    title: 'Multi-Ecosystem',
    description: 'Unterstützt npm, Python, Go, Java, Rust und PHP mit nativer Registry-Anbindung.',
    color: 'text-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/20',
  },
  {
    title: 'Team-Übersicht',
    description: 'Health-Scores, Risk-Vergleich und Trend-Analyse über alle Repositories.',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
  },
  {
    title: 'Policy Engine',
    description: 'Eigene Regeln für Lizenzen, CVE-Schwellen und maximales Dependency-Alter.',
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/10 border-yellow-500/20',
  },
];

export default async function HomePage() {
  const session = await auth();
  if (session?.user) redirect('/dashboard');

  return (
    <main className="min-h-screen">
      {/* Hero */}
      <div className="max-w-5xl mx-auto px-6 pt-24 pb-16">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-8">
            <svg viewBox="0 0 24 24" className="w-7 h-7 text-white fill-current">
              <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16zm0 3a1 1 0 00-1 1v3.586l-2.707 2.707a1 1 0 001.414 1.414l3-3A1 1 0 0013 12V8a1 1 0 00-1-1z" />
            </svg>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white tracking-tight mb-4">
            depsight
          </h1>
          <p className="text-xl text-gray-400 mb-2">
            Developer Security Dashboard
          </p>
          <p className="text-sm text-gray-500 max-w-md mx-auto mb-10">
            Verbinde deine GitHub-Repos und erhalte sofort Einblick in CVEs,
            Lizenz-Risiken und veraltete Dependencies &mdash; über alle Ökosysteme hinweg.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 px-8 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 transition-colors text-sm"
          >
            Jetzt starten
          </Link>
        </div>
      </div>

      {/* Features grid */}
      <div className="max-w-5xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className={`rounded-xl border p-5 ${f.bg}`}
            >
              <h3 className={`text-sm font-semibold mb-1.5 ${f.color}`}>
                {f.title}
              </h3>
              <p className="text-xs text-gray-400 leading-relaxed">
                {f.description}
              </p>
            </div>
          ))}
        </div>

        {/* Ecosystems bar */}
        <div className="mt-12 text-center">
          <p className="text-[10px] text-gray-600 uppercase tracking-widest mb-3">
            Unterstützte Ökosysteme
          </p>
          <div className="flex items-center justify-center gap-6 text-sm text-gray-500">
            {['npm', 'Python', 'Go', 'Java', 'Rust', 'PHP'].map((e) => (
              <span key={e} className="font-mono">{e}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-6">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between text-xs text-gray-600">
          <span>depsight</span>
          <span>Open Source &middot; GitHub-connected</span>
        </div>
      </footer>
    </main>
  );
}
