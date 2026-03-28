'use client';

import { AppShell } from '@/components/AppShell';
import { PolicyList } from '@/components/PolicyList';

interface Policy {
  id: string;
  name: string;
  type: 'LICENSE_DENY' | 'LICENSE_ALLOW_ONLY' | 'CVE_MIN_SEVERITY' | 'DEPENDENCY_MAX_AGE';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  rule: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}

interface PoliciesClientProps {
  policies: Policy[];
}

export function PoliciesClient({ policies }: PoliciesClientProps) {
  return (
    <AppShell>
      <div className="max-w-3xl">
        <PolicyList initialPolicies={policies} />
      </div>
    </AppShell>
  );
}
