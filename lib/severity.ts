import type { Severity } from '@prisma/client';

// The single severity ranking shared by the policy engine and the notifier:
// CRITICAL > HIGH > MEDIUM > LOW > UNKNOWN. Only the relative order matters.
export const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  UNKNOWN: 0,
};

// Rank of a severity string. An unrecognised value ranks like UNKNOWN (0).
export function severityValue(severity: string): number {
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity)
    ? SEVERITY_RANK[severity as Severity]
    : 0;
}

// True when severity `a` is at least as severe as `b`.
export function severityGte(a: string, b: string): boolean {
  return severityValue(a) >= severityValue(b);
}
