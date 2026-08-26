'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useLocale, LOCALE_LABELS, type Locale } from '@/lib/i18n';
import { ConfirmModal } from '@/components/ConfirmModal';

type TokenScope = 'READ' | 'WRITE';

interface TokenRow {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

interface SlackConfig {
  id: string;
  webhookUrl: string;
  channel: string | null;
  minSeverity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  enabled: boolean;
}

const LOCALES: Locale[] = ['de', 'en'];

export function SettingsClient() {
  const { t, locale, setLocale } = useLocale();

  // --- API tokens state ---
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('READ');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeError, setRevokeError] = useState(false);
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);

  // --- Webhooks state ---
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [webhooksLoadError, setWebhooksLoadError] = useState(false);
  const [webhookName, setWebhookName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookEvents, setWebhookEvents] = useState<string[]>([]);
  const [webhookCreating, setWebhookCreating] = useState(false);
  const [webhookCreateError, setWebhookCreateError] = useState<string | null>(null);

  // --- Slack state ---
  const [slackConfig, setSlackConfig] = useState<SlackConfig | null>(null);
  const [slackLoadError, setSlackLoadError] = useState(false);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState('');
  const [slackChannel, setSlackChannel] = useState('');
  const [slackMinSeverity, setSlackMinSeverity] = useState<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'>('HIGH');
  const [slackEnabled, setSlackEnabled] = useState(true);
  const [slackSaving, setSlackSaving] = useState(false);
  const [slackSaveError, setSlackSaveError] = useState<string | null>(null);
  const [slackRemoving, setSlackRemoving] = useState(false);
  const [slackRemoveError, setSlackRemoveError] = useState<string | null>(null);

  // --- Load functions ---
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

  const loadWebhooks = useCallback(async () => {
    try {
      const res = await fetch('/api/webhooks');
      if (!res.ok) throw new Error('load failed');
      const data = (await res.json()) as { webhooks: WebhookRow[] };
      setWebhooks(data.webhooks);
      setWebhooksLoadError(false);
    } catch {
      setWebhooksLoadError(true);
    }
  }, []);

  const loadSlack = useCallback(async () => {
    try {
      const res = await fetch('/api/slack');
      if (!res.ok) throw new Error('load failed');
      const data = (await res.json()) as { config: SlackConfig | null };
      setSlackConfig(data.config);
      if (data.config) {
        setSlackWebhookUrl(data.config.webhookUrl);
        setSlackChannel(data.config.channel ?? '');
        setSlackMinSeverity(data.config.minSeverity);
        setSlackEnabled(data.config.enabled);
      }
      setSlackLoadError(false);
    } catch {
      setSlackLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  useEffect(() => {
    void loadWebhooks();
  }, [loadWebhooks]);

  useEffect(() => {
    void loadSlack();
  }, [loadSlack]);

  // --- API token handlers ---
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
        body: JSON.stringify({ name: trimmed, scope }),
      });
      if (!res.ok) throw new Error('create failed');
      const data = (await res.json()) as { token: string };
      setRevealed(data.token);
      setName('');
      setScope('READ');
      setCopied(false);
      await loadTokens();
    } catch {
      setCreateError(t['token.createError']);
    } finally {
      setCreating(false);
    }
  }

  async function doRevokeToken(id: string) {
    setRevokeConfirmId(null);
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

  // --- Webhook handlers ---
  function toggleWebhookEvent(event: string) {
    setWebhookEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  async function createWebhook(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = webhookName.trim();
    const trimmedUrl = webhookUrl.trim();
    if (!trimmedName) {
      setWebhookCreateError(t['settings.webhooks.nameRequired']);
      return;
    }
    if (!trimmedUrl) {
      setWebhookCreateError(t['settings.webhooks.urlRequired']);
      return;
    }
    if (webhookEvents.length === 0) {
      setWebhookCreateError(t['settings.webhooks.eventsRequired']);
      return;
    }
    setWebhookCreating(true);
    setWebhookCreateError(null);
    try {
      const body: { name: string; url: string; events: string[]; secret?: string } = {
        name: trimmedName,
        url: trimmedUrl,
        events: webhookEvents,
      };
      const trimmedSecret = webhookSecret.trim();
      if (trimmedSecret) body.secret = trimmedSecret;
      const res = await fetch('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setWebhookCreateError(data.error ?? t['settings.webhooks.createError']);
        return;
      }
      setWebhookName('');
      setWebhookUrl('');
      setWebhookSecret('');
      setWebhookEvents([]);
      await loadWebhooks();
    } catch {
      setWebhookCreateError(t['settings.webhooks.createError']);
    } finally {
      setWebhookCreating(false);
    }
  }

  // --- Slack handlers ---
  async function saveSlack(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedUrl = slackWebhookUrl.trim();
    if (!trimmedUrl) {
      setSlackSaveError(t['settings.slack.urlRequired']);
      return;
    }
    setSlackSaving(true);
    setSlackSaveError(null);
    try {
      const res = await fetch('/api/slack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: trimmedUrl,
          channel: slackChannel.trim() || undefined,
          minSeverity: slackMinSeverity,
          enabled: slackEnabled,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setSlackSaveError(data.error ?? t['settings.slack.saveError']);
        return;
      }
      await loadSlack();
    } catch {
      setSlackSaveError(t['settings.slack.saveError']);
    } finally {
      setSlackSaving(false);
    }
  }

  async function removeSlack() {
    setSlackRemoving(true);
    setSlackRemoveError(null);
    try {
      const res = await fetch('/api/slack', { method: 'DELETE' });
      if (!res.ok) throw new Error('remove failed');
      setSlackConfig(null);
      setSlackWebhookUrl('');
      setSlackChannel('');
      setSlackMinSeverity('HIGH');
      setSlackEnabled(true);
    } catch {
      setSlackRemoveError(t['settings.slack.removeError']);
    } finally {
      setSlackRemoving(false);
    }
  }

  // --- Utilities ---
  function formatDate(iso: string | null): string {
    if (!iso) return t['token.never'];
    return new Date(iso).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  const webhookEventOptions = [
    { value: 'cve.critical', label: t['settings.webhooks.event.cve.critical'] },
    { value: 'cve.high', label: t['settings.webhooks.event.cve.high'] },
    { value: 'scan.completed', label: t['settings.webhooks.event.scan.completed'] },
  ];

  const severityLabels: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', string> = {
    CRITICAL: t['severity.critical'],
    HIGH: t['severity.high'],
    MEDIUM: t['severity.medium'],
    LOW: t['severity.low'],
  };

  const inputCls =
    'w-full rounded-md border border-gray-800 bg-gray-900 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-gray-600 focus:outline-none';
  const labelCls = 'block text-xs font-medium text-gray-400 mb-1';

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
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as TokenScope)}
              aria-label={t['token.scope']}
              className="rounded-md border border-gray-800 bg-gray-900 px-2 py-1.5 text-sm text-gray-200 focus:border-gray-600 focus:outline-none"
            >
              <option value="READ">{t['token.scopeRead']}</option>
              <option value="WRITE">{t['token.scopeWrite']}</option>
            </select>
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
                        <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-700 rounded px-1 py-0.5">
                          {tk.scope === 'READ' ? t['token.scopeRead'] : t['token.scopeWrite']}
                        </span>
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
                        onClick={() => setRevokeConfirmId(tk.id)}
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

        {/* Webhooks */}
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">{t['settings.webhooks.title']}</h2>
            <p className="text-xs text-gray-500">{t['settings.webhooks.desc']}</p>
          </div>

          {/* Create form */}
          <form onSubmit={createWebhook} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{t['settings.webhooks.name']}</label>
                <input
                  type="text"
                  value={webhookName}
                  onChange={(e) => setWebhookName(e.target.value)}
                  placeholder={t['settings.webhooks.namePlaceholder']}
                  maxLength={100}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>{t['settings.webhooks.url']}</label>
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder={t['settings.webhooks.urlPlaceholder']}
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label className={labelCls}>{t['settings.webhooks.secret']}</label>
              <input
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={t['settings.webhooks.secretPlaceholder']}
                className={inputCls}
              />
            </div>
            <div>
              <span className="block text-xs font-medium text-gray-400 mb-1.5">
                {t['settings.webhooks.events']}
              </span>
              <div className="flex flex-wrap gap-4">
                {webhookEventOptions.map((ev) => (
                  <label
                    key={ev.value}
                    className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={webhookEvents.includes(ev.value)}
                      onChange={() => toggleWebhookEvent(ev.value)}
                      className="accent-blue-600"
                    />
                    {ev.label}
                  </label>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={webhookCreating}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {webhookCreating ? t['settings.webhooks.creating'] : t['settings.webhooks.create']}
            </button>
            {webhookCreateError && (
              <div className="text-xs text-red-400">{webhookCreateError}</div>
            )}
            {webhooksLoadError && (
              <div className="text-xs text-red-400">{t['settings.webhooks.loadError']}</div>
            )}
          </form>

          {/* Webhook list */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              {t['settings.webhooks.listTitle']}
            </h3>
            <p className="text-xs text-gray-600">{t['settings.webhooks.noDelete']}</p>
            {webhooks.length === 0 ? (
              <p className="text-xs text-gray-600">{t['settings.webhooks.empty']}</p>
            ) : (
              <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800">
                {webhooks.map((wh) => (
                  <li key={wh.id} className="px-3 py-2.5 space-y-0.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-gray-200 truncate">{wh.name}</span>
                      <span
                        className={`text-[10px] uppercase tracking-wide border rounded px-1 py-0.5 shrink-0 ${
                          wh.enabled
                            ? 'text-emerald-400 border-emerald-900/60'
                            : 'text-gray-500 border-gray-800'
                        }`}
                      >
                        {wh.enabled
                          ? t['settings.webhooks.enabled']
                          : t['settings.webhooks.disabled']}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 truncate">{wh.url}</div>
                    <div className="text-xs text-gray-600">
                      {wh.events.map((id) => webhookEventOptions.find((o) => o.value === id)?.label ?? id).join(', ')}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Slack */}
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">{t['settings.slack.title']}</h2>
            <p className="text-xs text-gray-500">{t['settings.slack.desc']}</p>
          </div>

          {slackLoadError && (
            <div className="text-xs text-red-400">{t['settings.slack.loadError']}</div>
          )}

          <form onSubmit={saveSlack} className="space-y-3">
            <div>
              <label className={labelCls}>{t['settings.slack.webhookUrl']}</label>
              <input
                type="url"
                value={slackWebhookUrl}
                onChange={(e) => setSlackWebhookUrl(e.target.value)}
                placeholder={t['settings.slack.webhookUrlPlaceholder']}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t['settings.slack.channel']}</label>
              <input
                type="text"
                value={slackChannel}
                onChange={(e) => setSlackChannel(e.target.value)}
                placeholder={t['settings.slack.channelPlaceholder']}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>{t['settings.slack.minSeverity']}</label>
              <select
                value={slackMinSeverity}
                onChange={(e) =>
                  setSlackMinSeverity(e.target.value as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW')
                }
                className={inputCls}
              >
                {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((sev) => (
                  <option key={sev} value={sev}>
                    {severityLabels[sev]}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={slackEnabled}
                onChange={(e) => setSlackEnabled(e.target.checked)}
                className="accent-blue-600"
              />
              {t['settings.slack.enabled']}
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={slackSaving}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                {slackSaving ? t['settings.slack.saving'] : t['settings.slack.save']}
              </button>
              {slackConfig && (
                <button
                  type="button"
                  onClick={removeSlack}
                  disabled={slackRemoving}
                  className="px-3 py-1.5 rounded-md text-sm font-medium border border-gray-800 text-gray-400 hover:text-red-400 hover:border-red-900/60 disabled:opacity-50 transition-colors"
                >
                  {slackRemoving ? t['settings.slack.removing'] : t['settings.slack.remove']}
                </button>
              )}
            </div>
            {slackSaveError && <div className="text-xs text-red-400">{slackSaveError}</div>}
            {slackRemoveError && <div className="text-xs text-red-400">{slackRemoveError}</div>}
          </form>
        </section>
      </div>
      <ConfirmModal
        open={revokeConfirmId !== null}
        title={t['token.revoke']}
        message={t['token.revokeConfirm']}
        confirmLabel={t['token.revoke']}
        cancelLabel={t['confirm.cancel']}
        onConfirm={() => { if (revokeConfirmId) void doRevokeToken(revokeConfirmId); }}
        onCancel={() => setRevokeConfirmId(null)}
        destructive
      />
    </AppShell>
  );
}
