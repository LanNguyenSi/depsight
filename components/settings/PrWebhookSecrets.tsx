'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/lib/i18n';
import { ConfirmModal } from '@/components/ConfirmModal';

interface RepoRow {
  id: string;
  fullName: string;
  configured: boolean;
  usable: boolean;
  rotatedAt: string | null;
}

interface Pending {
  kind: 'rotate' | 'remove';
  repo: RepoRow;
}

/**
 * Settings section for the per-repository PR-scan webhook secrets. The secret
 * is returned once by the API; this component holds it in memory only until the
 * user dismisses it and never stores it.
 */
export function PrWebhookSecrets() {
  const { t, locale } = useLocale();
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ repository: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/webhook-secrets');
      if (!res.ok) throw new Error('load failed');
      const data = (await res.json()) as { repos: RepoRow[] };
      setRepos(data.repos);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate(repo: RepoRow) {
    setPending(null);
    setBusyId(repo.id);
    setActionError(false);
    try {
      const res = await fetch(`/api/webhook-secrets/${encodeURIComponent(repo.id)}`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('generate failed');
      const data = (await res.json()) as { secret: string; repository: string };
      setRevealed({ repository: data.repository, secret: data.secret });
      setCopied(false);
      await load();
    } catch {
      setActionError(true);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(repo: RepoRow) {
    setPending(null);
    setBusyId(repo.id);
    setActionError(false);
    try {
      const res = await fetch(`/api/webhook-secrets/${encodeURIComponent(repo.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('remove failed');
      if (revealed?.repository === repo.fullName) setRevealed(null);
      await load();
    } catch {
      setActionError(true);
    } finally {
      setBusyId(null);
    }
  }

  async function copySecret() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const payloadUrl =
    typeof window === 'undefined' ? '/api/webhooks/github' : `${window.location.origin}/api/webhooks/github`;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-200">{t['settings.prwh.title']}</h2>
        <p className="text-xs text-gray-500">{t['settings.prwh.desc']}</p>
        <p className="text-xs text-gray-500 mt-1">
          {t['settings.prwh.payloadUrl']}:{' '}
          <code className="font-mono text-gray-300">{payloadUrl}</code>
        </p>
      </div>

      {revealed && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 space-y-2">
          <div className="text-xs font-semibold text-amber-300">
            {t['settings.prwh.revealTitle']} · {revealed.repository}
          </div>
          <div className="text-xs text-amber-200/80">{t['settings.prwh.revealWarning']}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-gray-950 border border-gray-800 px-2 py-1.5 text-xs text-gray-200 font-mono">
              {revealed.secret}
            </code>
            <button
              type="button"
              onClick={copySecret}
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

      {loadError && <div className="text-xs text-red-400">{t['settings.prwh.loadError']}</div>}
      {actionError && <div className="text-xs text-red-400">{t['settings.prwh.actionError']}</div>}

      {repos.length === 0 && !loadError ? (
        <p className="text-xs text-gray-600">{t['settings.prwh.empty']}</p>
      ) : (
        <ul className="divide-y divide-gray-800 rounded-lg border border-gray-800">
          {repos.map((repo) => (
            <li key={repo.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-200 truncate">{repo.fullName}</div>
                <div className="text-xs text-gray-600">
                  {repo.configured
                    ? `${t['settings.prwh.configured']} · ${t['settings.prwh.rotatedOn']} ${
                        repo.rotatedAt
                          ? new Date(repo.rotatedAt).toLocaleDateString(locale, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })
                          : '-'
                      }`
                    : t['settings.prwh.notConfigured']}
                </div>
                {repo.configured && !repo.usable && (
                  <div className="text-xs text-amber-400" role="alert">
                    {t['settings.prwh.unusable']}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-3 text-xs">
                {repo.configured ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === repo.id}
                      onClick={() => setPending({ kind: 'rotate', repo })}
                      className="text-gray-300 hover:text-white disabled:opacity-50 transition-colors"
                    >
                      {busyId === repo.id ? t['settings.prwh.working'] : t['settings.prwh.rotate']}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === repo.id}
                      onClick={() => setPending({ kind: 'remove', repo })}
                      className="text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                    >
                      {t['settings.prwh.remove']}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={busyId === repo.id}
                    onClick={() => void generate(repo)}
                    className="text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
                  >
                    {busyId === repo.id ? t['settings.prwh.working'] : t['settings.prwh.generate']}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal
        open={pending !== null}
        title={
          pending?.kind === 'remove' ? t['settings.prwh.remove'] : t['settings.prwh.rotate']
        }
        message={
          pending?.kind === 'remove'
            ? t['settings.prwh.removeConfirm']
            : t['settings.prwh.rotateConfirm']
        }
        confirmLabel={
          pending?.kind === 'remove' ? t['settings.prwh.remove'] : t['settings.prwh.rotate']
        }
        cancelLabel={t['confirm.cancel']}
        onConfirm={() => {
          if (!pending) return;
          if (pending.kind === 'remove') void remove(pending.repo);
          else void generate(pending.repo);
        }}
        onCancel={() => setPending(null)}
        destructive
      />
    </section>
  );
}
