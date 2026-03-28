'use client';

import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { type Locale, type Translations, type TranslationKey, DEFAULT_LOCALE, getTranslations } from './translations';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translations;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readCookie(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const match = document.cookie.match(/(?:^|; )locale=(de|en)/);
  return (match?.[1] as Locale) ?? DEFAULT_LOCALE;
}

function writeCookie(locale: Locale) {
  document.cookie = `locale=${locale};path=/;max-age=${365 * 24 * 60 * 60};SameSite=Lax`;
}

export function LocaleProvider({ children, initialLocale }: { children: React.ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? readCookie());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeCookie(next);
  }, []);

  const value = useMemo(() => ({
    locale,
    setLocale,
    t: getTranslations(locale),
  }), [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}

/** Template string helper: t['severity.total'] with {count} → replaces with value */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
}
