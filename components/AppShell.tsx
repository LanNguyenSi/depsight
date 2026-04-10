'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '@/app/actions';
import { useLocale, LOCALE_LABELS } from '@/lib/i18n';

interface AppShellProps {
  children: React.ReactNode;
  repoCount?: number;
}

export function AppShell({ children, repoCount }: AppShellProps) {
  const pathname = usePathname();
  const { t, locale, setLocale } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);

  const NAV_ITEMS = [
    { href: '/overview', label: t['nav.overview'] },
    { href: '/dashboard', label: t['nav.dashboard'] },
    { href: '/policies', label: t['nav.policies'] },
  ];

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4 sm:gap-6">
            <Link href="/overview" className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
                <svg viewBox="0 0 16 16" className="w-4 h-4 text-white fill-current">
                  <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5a1 1 0 00-1 1v2.586l-1.707 1.707a1 1 0 001.414 1.414l2-2A1 1 0 009 9V6a1 1 0 00-1-1z" />
                </svg>
              </div>
              <span className="text-sm font-semibold text-white tracking-tight">depsight</span>
            </Link>
            {/* Desktop nav */}
            <nav className="hidden sm:flex items-center gap-1">
              {NAV_ITEMS.map(({ href, label }) => {
                const active = pathname === href;
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      active
                        ? 'bg-gray-800 text-white'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                    }`}
                  >
                    {label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3 sm:gap-4">
            {typeof repoCount === 'number' && (
              <span className="hidden sm:inline text-xs text-gray-500 tabular-nums">
                {repoCount} {t['app.repositories']}
              </span>
            )}
            {/* Language switcher */}
            <button
              onClick={() => setLocale(locale === 'de' ? 'en' : 'de')}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors font-medium"
              title={LOCALE_LABELS[locale === 'de' ? 'en' : 'de']}
            >
              {locale === 'de' ? 'EN' : 'DE'}
            </button>
            <form action={logout}>
              <button
                type="submit"
                className="hidden sm:block text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                {t['nav.logout']}
              </button>
            </form>
            {/* Mobile menu button */}
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="sm:hidden p-1.5 text-gray-400 hover:text-gray-200 transition-colors"
              aria-label={t['nav.menu']}
            >
              <svg viewBox="0 0 20 20" className="w-5 h-5 fill-current">
                {menuOpen ? (
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                ) : (
                  <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
                )}
              </svg>
            </button>
          </div>
        </div>
        {/* Mobile dropdown */}
        {menuOpen && (
          <div className="sm:hidden border-t border-gray-800 px-4 py-3 space-y-1" style={{ animation: 'slideDown 150ms ease-out' }}>
            {NAV_ITEMS.map(({ href, label }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMenuOpen(false)}
                  className={`block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    active
                      ? 'bg-gray-800 text-white'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            {typeof repoCount === 'number' && (
              <div className="px-3 py-2 text-xs text-gray-600">{repoCount} {t['app.repositories']}</div>
            )}
            <form action={logout}>
              <button
                type="submit"
                className="block w-full text-left px-3 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 rounded-md transition-colors"
              >
                {t['nav.logout']}
              </button>
            </form>
          </div>
        )}
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6">{children}</main>
    </div>
  );
}
