import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { listPolicies } from '@/lib/policy/service';
import { PoliciesClient } from './PoliciesClient';

export const dynamic = 'force-dynamic';

export default async function PoliciesPage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const policies = await listPolicies(session.user.id);

  const serialized = policies.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type as 'LICENSE_DENY' | 'LICENSE_ALLOW_ONLY' | 'CVE_MIN_SEVERITY' | 'DEPENDENCY_MAX_AGE',
    severity: p.severity as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN',
    rule: p.rule as Record<string, unknown>,
    enabled: p.enabled,
    createdAt: p.createdAt.toISOString(),
  }));

  return <PoliciesClient policies={serialized} />;
}
