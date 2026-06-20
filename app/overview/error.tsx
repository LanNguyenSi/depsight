'use client';

import { parseLocaleCookie, getTranslations } from '@/lib/i18n';

export default function OverviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Detect locale from the app's locale cookie (written as 'locale' by LocaleProvider).
  let cookie: string | undefined;
  try {
    cookie = document.cookie;
  } catch {
    // ignore (SSR or cookie unavailable)
  }
  const t = getTranslations(parseLocaleCookie(cookie));

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 max-w-md w-full text-center">
        <div className="w-12 h-12 rounded-full bg-red-950/50 border border-red-900/50 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="text-base font-semibold text-white mb-2">{t['error.title']}</h2>
        <p className="text-sm text-gray-400 mb-6">{t['error.message']}</p>
        {process.env.NODE_ENV !== 'production' && error.message && (
          <p className="text-xs text-gray-600 font-mono mb-4 truncate">{error.message}</p>
        )}
        <button
          onClick={reset}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {t['error.retry']}
        </button>
      </div>
    </div>
  );
}
