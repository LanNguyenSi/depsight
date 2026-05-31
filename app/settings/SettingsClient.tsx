'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useLocale, LOCALE_LABELS, type Locale } from '@/lib/i18n';

interface TokenRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const LOCALES: Locale[] = ['de', 'en'];

export function SettingsClient() {
  const { t, locale, setLocale } = useLocale();

  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeError, setRevokeError] = useState(false);

  const loadTokens = useCallback(async () => {
    try {
      const res = await fetch('/api/tokens');
      if (!res.ok) throw new Error('load failed');
      const data = (await res.json()) as { tokens: TokenRow[] };
      setTokens(data.tokens);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  async function createToken(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setCreateError(t['token.nameRequired']);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error('create failed');
      const data = (await res.json()) as { token: string };
      setRevealed(data.token);
      setName('');
      setCopied(false);
      await loadTokens();
    } catch {
      setCreateError(t['token.createError']);
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(id: string) {
    if (!window.confirm(t['token.revokeConfirm'])) return;
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('revoke failed');
      setRevokeError(false);
      await loadTokens();
    } catch {
      setRevokeError(true);
    }
  }

  async function copyToken() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function formatDate(iso: string | null): string {
    if (!iso) return t['token.never'];
    return new Date(iso).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto space-y-8">
        <h1 className="text-lg font-semibold text-white">{t['settings.title']}</h1>

        {/* Language */}
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">{t['settings.language']}</h2>
            <p className="text-xs text-gray-500">{t['settings.languageDesc']}</p>
          </div>
          <div className="flex gap-2">
            {LOCALES.map((loc) => (
              <button
                key={loc}
                type="button"
                onClick={() => setLocale(loc)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                  locale === loc
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'border-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-700'
                }`}
              >
                {LOCALE_LABELS[loc]}
              </button>
            ))}
          </div>
        </section>

        {/* API tokens */}
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">{t['settings.tokens']}</h2>
            <p className="text-xs text-gray-500">{t['settings.tokensDesc']}</p>
          </div>

          {/* Reveal-once box */}
          {revealed && (
            <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 space-y-2">
              <div className="text-xs font-semibold text-amber-300">{t['token.revealTitle']}</div>
              <div className="text-xs text-amber-200/80">{t['token.revealWarning']}</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-gray-950 border border-gray-800 px-2 py-1.5 text-xs text-gray-200 font-mono">
                  {revealed}
                </code>
                <button
                  type="button"
                  onClick={copyToken}
                  className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors"
                >
                  {copied ? t['token.copied'] : t['token.copy']}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setRevealed(null)}
                className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                {t['token.done']}
              </button>
            </div>
          )}

          {/* Create form */}
          <form onSubmit={createToken} className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t['token.namePlaceholder']}
              maxLength={100}
              className="flex-1 rounded-md border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-gray-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={creating}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {creating ? t['token.creating'] : t['token.create']}
            </button>
          </form>
          {createError && <div className="text-xs text-red-400">{createError}</div>}
          {loadError && <div className="text-xs text-red-400">{t['token.loadError']}</div>}
          {revokeError && <div className="text-xs text-red-400">{t['token.revokeError']}</div>}

          {/* Token list */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              {t['token.listTitle']}
            </h3>
            {tokens.length === 0 ? (
              <p className="text-xs text-gray-600">{t['token.empty']}</p>
            ) : (
              <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800">
                {tokens.map((tk) => (
                  <li key={tk.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-200 truncate">{tk.name}</span>
                        {tk.revokedAt && (
                          <span className="text-[10px] uppercase tracking-wide text-red-400 border border-red-900/60 rounded px-1 py-0.5">
                            {t['token.revoked']}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-600">
                        {t['token.created']} {formatDate(tk.createdAt)} · {t['token.lastUsed']}{' '}
                        {formatDate(tk.lastUsedAt)}
                      </div>
                    </div>
                    {!tk.revokedAt && (
                      <button
                        type="button"
                        onClick={() => revokeToken(tk.id)}
                        className="shrink-0 text-xs text-red-400 hover:text-red-300 transition-colors"
                      >
                        {t['token.revoke']}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
