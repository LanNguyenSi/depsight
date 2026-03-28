'use client';

import { useState } from 'react';
import { useLocale } from '@/lib/i18n';
import type { Translations } from '@/lib/i18n';

type PolicyType = 'LICENSE_DENY' | 'LICENSE_ALLOW_ONLY' | 'CVE_MIN_SEVERITY' | 'DEPENDENCY_MAX_AGE';
type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

interface Policy {
  id: string;
  name: string;
  type: PolicyType;
  severity: Severity;
  rule: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

interface PolicyListProps {
  initialPolicies: Policy[];
}

function policyTypeLabel(type: PolicyType, t: Translations): string {
  switch (type) {
    case 'LICENSE_DENY': return t['policy.type.licenseDeny'];
    case 'LICENSE_ALLOW_ONLY': return t['policy.type.licenseAllow'];
    case 'CVE_MIN_SEVERITY': return t['policy.type.cveSeverity'];
    case 'DEPENDENCY_MAX_AGE': return t['policy.type.maxAge'];
  }
}

const POLICY_TYPE_STYLES: Record<PolicyType, string> = {
  LICENSE_DENY: 'bg-red-950/50 text-red-400 border-red-900/50',
  LICENSE_ALLOW_ONLY: 'bg-emerald-950/50 text-emerald-400 border-emerald-900/50',
  CVE_MIN_SEVERITY: 'bg-orange-950/50 text-orange-400 border-orange-900/50',
  DEPENDENCY_MAX_AGE: 'bg-blue-950/50 text-blue-400 border-blue-900/50',
};

const SEVERITY_STYLES: Record<Severity, string> = {
  CRITICAL: 'bg-red-950/60 text-red-400 border-red-900/50',
  HIGH: 'bg-orange-950/60 text-orange-400 border-orange-900/50',
  MEDIUM: 'bg-yellow-950/60 text-yellow-400 border-yellow-900/50',
  LOW: 'bg-blue-950/60 text-blue-400 border-blue-900/50',
  UNKNOWN: 'bg-gray-800 text-gray-500 border-gray-700',
};

const SEVERITY_OPTIONS: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

interface FormState {
  name: string;
  type: PolicyType;
  severity: Severity;
  deniedLicenses: string;
  allowedLicenses: string;
  minSeverity: Severity;
  maxAgeDays: string;
}

const DEFAULT_FORM: FormState = {
  name: '',
  type: 'LICENSE_DENY',
  severity: 'HIGH',
  deniedLicenses: '',
  allowedLicenses: '',
  minSeverity: 'HIGH',
  maxAgeDays: '365',
};

function buildRule(form: FormState): Record<string, unknown> {
  switch (form.type) {
    case 'LICENSE_DENY':
      return { deniedLicenses: form.deniedLicenses.split(',').map((s) => s.trim()).filter(Boolean) };
    case 'LICENSE_ALLOW_ONLY':
      return { allowedLicenses: form.allowedLicenses.split(',').map((s) => s.trim()).filter(Boolean) };
    case 'CVE_MIN_SEVERITY':
      return { minSeverity: form.minSeverity };
    case 'DEPENDENCY_MAX_AGE':
      return { maxAgeDays: parseInt(form.maxAgeDays, 10) };
  }
}

export function PolicyList({ initialPolicies }: PolicyListProps) {
  const { t } = useLocale();
  const [policies, setPolicies] = useState<Policy[]>(initialPolicies);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async (policy: Policy) => {
    try {
      const res = await fetch(`/api/policies/${policy.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !policy.enabled }),
      });
      if (!res.ok) throw new Error(t['policy.error.update']);
      const data = (await res.json()) as { policy: Policy };
      setPolicies((prev) => prev.map((p) => (p.id === policy.id ? data.policy : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t['policy.error.unknown']);
    }
  };

  const handleDelete = async (policyId: string) => {
    if (!confirm(t['policy.deleteConfirm'])) return;
    try {
      const res = await fetch(`/api/policies/${policyId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(t['policy.error.delete']);
      setPolicies((prev) => prev.filter((p) => p.id !== policyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t['policy.error.unknown']);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError(t['policy.form.required']);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          severity: form.severity,
          rule: buildRule(form),
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? t['policy.error.save']);
      }

      const data = (await res.json()) as { policy: Policy };
      setPolicies((prev) => [data.policy, ...prev]);
      setForm(DEFAULT_FORM);
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t['policy.error.unknown']);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors';
  const labelCls = 'block text-xs font-medium text-gray-400 mb-1.5';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white">{t['policy.title']}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t['policy.subtitle']}
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 transition-colors"
        >
          {showForm ? t['policy.cancel'] : t['policy.new']}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-950/50 border border-red-900/50 text-red-400 text-sm rounded-lg px-4 py-3 flex items-center justify-between">
          {error}
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-300 ml-3">
            &times;
          </button>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-5">
          <h2 className="text-sm font-medium text-gray-400 mb-4">{t['policy.create']}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className={labelCls}>{t['policy.form.name']}</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t['policy.form.nameExample']}
                className={inputCls}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>{t['policy.form.type']}</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PolicyType }))}
                  className={inputCls}
                >
                  {(Object.keys(POLICY_TYPE_STYLES) as PolicyType[]).map((pt) => (
                    <option key={pt} value={pt}>{policyTypeLabel(pt, t)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>{t['policy.form.severity']}</label>
                <select
                  value={form.severity}
                  onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as Severity }))}
                  className={inputCls}
                >
                  {SEVERITY_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {form.type === 'LICENSE_DENY' && (
              <div>
                <label className={labelCls}>{t['policy.form.deniedLicenses']}</label>
                <textarea
                  value={form.deniedLicenses}
                  onChange={(e) => setForm((f) => ({ ...f, deniedLicenses: e.target.value }))}
                  placeholder={t['policy.form.deniedExample']}
                  rows={2}
                  className={`${inputCls} font-mono`}
                />
              </div>
            )}

            {form.type === 'LICENSE_ALLOW_ONLY' && (
              <div>
                <label className={labelCls}>{t['policy.form.allowedLicenses']}</label>
                <textarea
                  value={form.allowedLicenses}
                  onChange={(e) => setForm((f) => ({ ...f, allowedLicenses: e.target.value }))}
                  placeholder={t['policy.form.allowedExample']}
                  rows={2}
                  className={`${inputCls} font-mono`}
                />
              </div>
            )}

            {form.type === 'CVE_MIN_SEVERITY' && (
              <div>
                <label className={labelCls}>{t['policy.form.minSeverity']}</label>
                <select
                  value={form.minSeverity}
                  onChange={(e) => setForm((f) => ({ ...f, minSeverity: e.target.value as Severity }))}
                  className={inputCls}
                >
                  {SEVERITY_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}

            {form.type === 'DEPENDENCY_MAX_AGE' && (
              <div>
                <label className={labelCls}>{t['policy.form.maxAge']}</label>
                <input
                  type="number"
                  min={1}
                  value={form.maxAgeDays}
                  onChange={(e) => setForm((f) => ({ ...f, maxAgeDays: e.target.value }))}
                  placeholder="365"
                  className={inputCls}
                />
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => { setShowForm(false); setForm(DEFAULT_FORM); }}
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
              >
                {t['policy.cancel']}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                {saving ? t['policy.form.saving'] : t['policy.form.save']}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Policy list */}
      {policies.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-gray-500 text-sm">{t['policy.empty']}</p>
          <p className="text-gray-600 text-xs mt-1">
            {t['policy.emptyDesc']}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {policies.map((policy) => (
            <PolicyRow
              key={policy.id}
              policy={policy}
              onToggle={handleToggle}
              onDelete={handleDelete}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PolicyRowProps {
  policy: Policy;
  onToggle: (policy: Policy) => void;
  onDelete: (id: string) => void;
  t: Translations;
}

function PolicyRow({ policy, onToggle, onDelete, t }: PolicyRowProps) {
  return (
    <div
      className={`flex items-center justify-between px-4 py-3 bg-gray-900 rounded-lg border ${
        policy.enabled ? 'border-gray-800' : 'border-gray-800/50 opacity-50'
      } hover:border-gray-700 transition-colors`}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-gray-200 truncate">{policy.name}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${POLICY_TYPE_STYLES[policy.type]}`}>
              {policyTypeLabel(policy.type, t)}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${SEVERITY_STYLES[policy.severity]}`}>
              {policy.severity}
            </span>
          </div>
          <p className="text-xs text-gray-600 mt-0.5">
            {new Date(policy.createdAt).toLocaleDateString('de-DE')}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 ml-4 shrink-0">
        <button
          onClick={() => onToggle(policy)}
          title={policy.enabled ? 'Deaktivieren' : 'Aktivieren'}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
            policy.enabled ? 'bg-blue-600' : 'bg-gray-700'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              policy.enabled ? 'translate-x-4' : 'translate-x-1'
            }`}
          />
        </button>
        <button
          onClick={() => onDelete(policy.id)}
          title={t['policy.delete']}
          className="text-gray-600 hover:text-red-400 transition-colors text-xs"
        >
          {t['policy.delete']}
        </button>
      </div>
    </div>
  );
}
