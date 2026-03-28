'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface AppShellProps {
  children: React.ReactNode;
  repoCount?: number;
}

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/overview', label: 'Übersicht' },
  { href: '/policies', label: 'Policies' },
];

export function AppShell({ children, repoCount }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center">
                <svg viewBox="0 0 16 16" className="w-4 h-4 text-white fill-current">
                  <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5a1 1 0 00-1 1v2.586l-1.707 1.707a1 1 0 001.414 1.414l2-2A1 1 0 009 9V6a1 1 0 00-1-1z" />
                </svg>
              </div>
              <span className="text-sm font-semibold text-white tracking-tight">depsight</span>
            </Link>
            <nav className="flex items-center gap-1">
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
          {typeof repoCount === 'number' && (
            <span className="text-xs text-gray-500 tabular-nums">
              {repoCount} Repositories
            </span>
          )}
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-6">{children}</main>
    </div>
  );
}
