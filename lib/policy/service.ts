import { Prisma, PolicyType, Severity } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export interface CreatePolicyInput {
  name: string;
  type: PolicyType;
  rule: Prisma.InputJsonValue;
  severity: Severity;
  enabled?: boolean;
}

export interface UpdatePolicyInput {
  name?: string;
  type?: PolicyType;
  rule?: Prisma.InputJsonValue;
  severity?: Severity;
  enabled?: boolean;
}

export async function listPolicies(userId: string) {
  return prisma.policy.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getPolicyById(userId: string, policyId: string) {
  return prisma.policy.findFirst({
    where: { id: policyId, userId },
  });
}

export async function createPolicy(userId: string, input: CreatePolicyInput) {
  return prisma.policy.create({
    data: {
      userId,
      name: input.name,
      type: input.type,
      rule: input.rule,
      severity: input.severity,
      enabled: input.enabled ?? true,
    },
  });
}

export async function updatePolicy(
  userId: string,
  policyId: string,
  input: UpdatePolicyInput,
) {
  const existing = await prisma.policy.findFirst({
    where: { id: policyId, userId },
  });

  if (!existing) return null;

  return prisma.policy.update({
    where: { id: policyId },
    data: input,
  });
}

export async function deletePolicy(userId: string, policyId: string) {
  const existing = await prisma.policy.findFirst({
    where: { id: policyId, userId },
  });

  if (!existing) return false;

  await prisma.policy.delete({ where: { id: policyId } });
  return true;
}

export async function togglePolicy(userId: string, policyId: string) {
  const existing = await prisma.policy.findFirst({
    where: { id: policyId, userId },
  });

  if (!existing) return null;

  return prisma.policy.update({
    where: { id: policyId },
    data: { enabled: !existing.enabled },
  });
}
