'use client';

import { useState } from 'react';

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

const POLICY_TYPE_LABELS: Record<PolicyType, string> = {
  LICENSE_DENY: 'Lizenz verboten',
  LICENSE_ALLOW_ONLY: 'Lizenz Allowlist',
  CVE_MIN_SEVERITY: 'CVE Schwere',
  DEPENDENCY_MAX_AGE: 'Max. Alter',
};

const POLICY_TYPE_STYLES: Record<PolicyType, string> = {
  LICENSE_DENY: 'bg-red-50 text-red-700 border-red-200',
  LICENSE_ALLOW_ONLY: 'bg-green-50 text-green-700 border-green-200',
  CVE_MIN_SEVERITY: 'bg-orange-50 text-orange-700 border-orange-200',
  DEPENDENCY_MAX_AGE: 'bg-blue-50 text-blue-700 border-blue-200',
};

const SEVERITY_STYLES: Record<Severity, string> = {
  CRITICAL: 'bg-red-100 text-red-800 border-red-200',
  HIGH: 'bg-orange-100 text-orange-800 border-orange-200',
  MEDIUM: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  LOW: 'bg-blue-100 text-blue-800 border-blue-200',
  UNKNOWN: 'bg-gray-100 text-gray-600 border-gray-200',
};

const SEVERITY_OPTIONS: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

interface FormState {
  name: string;
  type: PolicyType;
  severity: Severity;
  // LICENSE_DENY
  deniedLicenses: string;
  // LICENSE_ALLOW_ONLY
  allowedLicenses: string;
  // CVE_MIN_SEVERITY
  minSeverity: Severity;
  // DEPENDENCY_MAX_AGE
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
      return {
        deniedLicenses: form.deniedLicenses.split(',').map((s) => s.trim()).filter(Boolean),
      };
    case 'LICENSE_ALLOW_ONLY':
      return {
        allowedLicenses: form.allowedLicenses.split(',').map((s) => s.trim()).filter(Boolean),
      };
    case 'CVE_MIN_SEVERITY':
      return { minSeverity: form.minSeverity };
    case 'DEPENDENCY_MAX_AGE':
      return { maxAgeDays: parseInt(form.maxAgeDays, 10) };
  }
}

export function PolicyList({ initialPolicies }: PolicyListProps) {
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
      if (!res.ok) throw new Error('Fehler beim Aktualisieren');
      const data = await res.json() as { policy: Policy };
      setPolicies((prev) =>
        prev.map((p) => (p.id === policy.id ? data.policy : p)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
    }
  };

  const handleDelete = async (policyId: string) => {
    if (!confirm('Policy wirklich löschen?')) return;
    try {
      const res = await fetch(`/api/policies/${policyId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Fehler beim Löschen');
      setPolicies((prev) => prev.filter((p) => p.id !== policyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name ist erforderlich');
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
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? 'Fehler beim Speichern');
      }

      const data = await res.json() as { policy: Policy };
      setPolicies((prev) => [data.policy, ...prev]);
      setForm(DEFAULT_FORM);
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Policies</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Regeln für Lizenzen, CVEs und Abhängigkeiten
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          {showForm ? '✕ Abbrechen' : '+ Neue Policy'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-3 text-red-500 hover:text-red-700"
          >
            ✕
          </button>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Neue Policy erstellen</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Name
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="z.B. Keine GPL-Lizenzen"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Type */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Typ
                </label>
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PolicyType }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {(Object.keys(POLICY_TYPE_LABELS) as PolicyType[]).map((t) => (
                    <option key={t} value={t}>
                      {POLICY_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Severity */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Schweregrad
                </label>
                <select
                  value={form.severity}
                  onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as Severity }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SEVERITY_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Dynamic rule fields */}
            {form.type === 'LICENSE_DENY' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Verbotene Lizenzen (kommagetrennt)
                </label>
                <textarea
                  value={form.deniedLicenses}
                  onChange={(e) => setForm((f) => ({ ...f, deniedLicenses: e.target.value }))}
                  placeholder="GPL-2.0, GPL-3.0, LGPL-2.1"
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {form.type === 'LICENSE_ALLOW_ONLY' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Erlaubte Lizenzen (kommagetrennt)
                </label>
                <textarea
                  value={form.allowedLicenses}
                  onChange={(e) => setForm((f) => ({ ...f, allowedLicenses: e.target.value }))}
                  placeholder="MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause"
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {form.type === 'CVE_MIN_SEVERITY' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Minimale CVE-Schwere (Verstöße ab dieser Stufe)
                </label>
                <select
                  value={form.minSeverity}
                  onChange={(e) => setForm((f) => ({ ...f, minSeverity: e.target.value as Severity }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SEVERITY_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}

            {form.type === 'DEPENDENCY_MAX_AGE' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Maximales Alter in Tagen
                </label>
                <input
                  type="number"
                  min={1}
                  value={form.maxAgeDays}
                  onChange={(e) => setForm((f) => ({ ...f, maxAgeDays: e.target.value }))}
                  placeholder="365"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => { setShowForm(false); setForm(DEFAULT_FORM); }}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Abbrechen
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Speichern…' : 'Policy speichern'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Policy list */}
      {policies.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <div className="text-4xl mb-3">🛡️</div>
          <p className="text-gray-500 text-sm">Noch keine Policies definiert.</p>
          <p className="text-gray-400 text-xs mt-1">
            Erstelle eine Policy, um Lizenzen, CVEs und Abhängigkeiten zu überwachen.
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
}

function PolicyRow({ policy, onToggle, onDelete }: PolicyRowProps) {
  return (
    <div
      className={`flex items-center justify-between px-4 py-3 bg-white rounded-lg border ${
        policy.enabled ? 'border-gray-200' : 'border-gray-100 opacity-60'
      } hover:border-gray-300 transition-colors`}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <span className="text-lg">{policy.enabled ? '🛡️' : '⏸️'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-gray-800 truncate">{policy.name}</span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${POLICY_TYPE_STYLES[policy.type]}`}
            >
              {POLICY_TYPE_LABELS[policy.type]}
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${SEVERITY_STYLES[policy.severity]}`}
            >
              {policy.severity}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {new Date(policy.createdAt).toLocaleDateString('de-DE')}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 ml-4 shrink-0">
        {/* Toggle */}
        <button
          onClick={() => onToggle(policy)}
          title={policy.enabled ? 'Deaktivieren' : 'Aktivieren'}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
            policy.enabled ? 'bg-blue-600' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              policy.enabled ? 'translate-x-4' : 'translate-x-1'
            }`}
          />
        </button>

        {/* Delete */}
        <button
          onClick={() => onDelete(policy.id)}
          title="Löschen"
          className="text-gray-400 hover:text-red-500 transition-colors p-1"
        >
          🗑️
        </button>
      </div>
    </div>
  );
}
