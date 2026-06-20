import { evaluatePolicies, type PolicyViolation } from '@/lib/policy/engine';
import { notifyScanCompleted } from './notifier';

export async function runPostScanHooks(
  userId: string,
  repoId: string,
  repoFullName: string,
  scanId: string,
  scanType: 'cve' | 'license' | 'deps',
  summary: Record<string, unknown>,
): Promise<void> {
  let violations: PolicyViolation[] = [];
  try {
    violations = await evaluatePolicies(userId, scanId);
  } catch (e) {
    console.error('[post-scan] policy eval failed:', e);
  }

  await notifyScanCompleted(
    userId,
    repoId,
    repoFullName,
    scanId,
    scanType,
    summary,
    violations.map((v) => ({
      policyName: v.policyName,
      severity: v.severity,
      message: v.message,
      affectedPackages: v.affectedPackages,
    })),
  );
}
