// Unit tests for lib/policy/service.ts — all 6 exported functions.
// Prisma is mocked at the module boundary; no DB access.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolicyType, Severity } from '@prisma/client';

// ---------------------------------------------------------------------------
// Hoist mock handles
// ---------------------------------------------------------------------------
const {
  policyFindMany,
  policyFindFirst,
  policyCreate,
  policyUpdate,
  policyDelete,
} = vi.hoisted(() => ({
  policyFindMany: vi.fn(),
  policyFindFirst: vi.fn(),
  policyCreate: vi.fn(),
  policyUpdate: vi.fn(),
  policyDelete: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('@/lib/prisma', () => ({
  prisma: {
    policy: {
      findMany: policyFindMany,
      findFirst: policyFindFirst,
      create: policyCreate,
      update: policyUpdate,
      delete: policyDelete,
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import {
  listPolicies,
  getPolicyById,
  createPolicy,
  updatePolicy,
  deletePolicy,
  togglePolicy,
} from '@/lib/policy/service';

// ---------------------------------------------------------------------------
// Shared reset helper
// ---------------------------------------------------------------------------
function resetAll() {
  policyFindMany.mockReset();
  policyFindFirst.mockReset();
  policyCreate.mockReset();
  policyUpdate.mockReset();
  policyDelete.mockReset();
}

// ---------------------------------------------------------------------------
// listPolicies
// ---------------------------------------------------------------------------
describe('listPolicies', () => {
  beforeEach(resetAll);

  it('calls policy.findMany with userId and orderBy createdAt desc', async () => {
    const policies = [{ id: 'pol-1', name: 'Block GPL', userId: 'user-1' }];
    policyFindMany.mockResolvedValue(policies);

    const result = await listPolicies('user-1');

    expect(result).toEqual(policies);
    expect(policyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('returns empty array when user has no policies', async () => {
    policyFindMany.mockResolvedValue([]);

    const result = await listPolicies('user-no-policies');

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getPolicyById
// ---------------------------------------------------------------------------
describe('getPolicyById', () => {
  beforeEach(resetAll);

  it('returns policy when found for user', async () => {
    const policy = { id: 'pol-1', name: 'Block GPL', userId: 'user-1' };
    policyFindFirst.mockResolvedValue(policy);

    const result = await getPolicyById('user-1', 'pol-1');

    expect(result).toEqual(policy);
    expect(policyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pol-1', userId: 'user-1' } }),
    );
  });

  it('returns null when policy does not exist or belongs to another user', async () => {
    policyFindFirst.mockResolvedValue(null);

    const result = await getPolicyById('user-1', 'pol-other');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createPolicy
// ---------------------------------------------------------------------------
describe('createPolicy', () => {
  beforeEach(resetAll);

  it('creates policy with all provided fields and returns created record', async () => {
    const created = {
      id: 'pol-new',
      userId: 'user-1',
      name: 'Block GPL',
      type: PolicyType.LICENSE_DENY,
      severity: Severity.HIGH,
      rule: { licenses: ['GPL-3.0'] },
      enabled: true,
    };
    policyCreate.mockResolvedValue(created);

    const result = await createPolicy('user-1', {
      name: 'Block GPL',
      type: PolicyType.LICENSE_DENY,
      severity: Severity.HIGH,
      rule: { licenses: ['GPL-3.0'] },
      enabled: true,
    });

    expect(result).toEqual(created);
    expect(policyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          name: 'Block GPL',
          type: PolicyType.LICENSE_DENY,
          severity: Severity.HIGH,
          enabled: true,
          rule: { licenses: ['GPL-3.0'] },
        }),
      }),
    );
  });

  it('defaults enabled to true when not provided', async () => {
    policyCreate.mockResolvedValue({ id: 'pol-x', enabled: true });

    await createPolicy('user-1', {
      name: 'CVE Guard',
      type: PolicyType.CVE_MIN_SEVERITY,
      severity: Severity.CRITICAL,
      rule: { minSeverity: 'CRITICAL' },
    });

    expect(policyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: true }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// updatePolicy
// ---------------------------------------------------------------------------
describe('updatePolicy', () => {
  beforeEach(resetAll);

  it('returns null when policy does not exist for user (ownership check fails)', async () => {
    policyFindFirst.mockResolvedValue(null);

    const result = await updatePolicy('user-1', 'pol-other', { name: 'New Name' });

    expect(result).toBeNull();
    expect(policyUpdate).not.toHaveBeenCalled();
  });

  it('updates and returns the updated record when ownership matches', async () => {
    const existing = { id: 'pol-1', name: 'Old Name', userId: 'user-1', enabled: true };
    const updated = { ...existing, name: 'New Name' };
    policyFindFirst.mockResolvedValue(existing);
    policyUpdate.mockResolvedValue(updated);

    const result = await updatePolicy('user-1', 'pol-1', { name: 'New Name' });

    expect(result).toEqual(updated);
    expect(policyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pol-1', userId: 'user-1' } }),
    );
    expect(policyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pol-1' },
        data: expect.objectContaining({ name: 'New Name' }),
      }),
    );
  });

  it('scopes ownership check by both id and userId to prevent IDOR', async () => {
    policyFindFirst.mockResolvedValue(null);

    await updatePolicy('attacker-id', 'pol-1', { name: 'Hijacked' });

    expect(policyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pol-1', userId: 'attacker-id' },
      }),
    );
    expect(policyUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deletePolicy
// ---------------------------------------------------------------------------
describe('deletePolicy', () => {
  beforeEach(resetAll);

  it('returns false when policy does not exist for user', async () => {
    policyFindFirst.mockResolvedValue(null);

    const result = await deletePolicy('user-1', 'pol-missing');

    expect(result).toBe(false);
    expect(policyDelete).not.toHaveBeenCalled();
  });

  it('deletes policy and returns true when ownership matches', async () => {
    const existing = { id: 'pol-1', userId: 'user-1', name: 'Block GPL' };
    policyFindFirst.mockResolvedValue(existing);
    policyDelete.mockResolvedValue(existing);

    const result = await deletePolicy('user-1', 'pol-1');

    expect(result).toBe(true);
    expect(policyDelete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pol-1' } }),
    );
  });

  it('scopes ownership check by both id and userId to prevent IDOR', async () => {
    policyFindFirst.mockResolvedValue(null);

    const result = await deletePolicy('attacker-id', 'pol-1');

    expect(result).toBe(false);
    expect(policyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pol-1', userId: 'attacker-id' },
      }),
    );
    expect(policyDelete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// togglePolicy
// ---------------------------------------------------------------------------
describe('togglePolicy', () => {
  beforeEach(resetAll);

  it('returns null when policy does not exist for user', async () => {
    policyFindFirst.mockResolvedValue(null);

    const result = await togglePolicy('user-1', 'pol-missing');

    expect(result).toBeNull();
    // IDOR: the ownership lookup must be scoped by userId (mirrors update/delete).
    expect(policyFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pol-missing', userId: 'user-1' },
      }),
    );
    expect(policyUpdate).not.toHaveBeenCalled();
  });

  it('toggles enabled from true to false', async () => {
    const existing = { id: 'pol-1', userId: 'user-1', enabled: true, name: 'Block GPL' };
    const toggled = { ...existing, enabled: false };
    policyFindFirst.mockResolvedValue(existing);
    policyUpdate.mockResolvedValue(toggled);

    const result = await togglePolicy('user-1', 'pol-1');

    expect(result).toEqual(toggled);
    expect(policyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pol-1' },
        data: { enabled: false },
      }),
    );
  });

  it('toggles enabled from false to true', async () => {
    const existing = { id: 'pol-1', userId: 'user-1', enabled: false, name: 'Block GPL' };
    const toggled = { ...existing, enabled: true };
    policyFindFirst.mockResolvedValue(existing);
    policyUpdate.mockResolvedValue(toggled);

    const result = await togglePolicy('user-1', 'pol-1');

    expect(result).toEqual(toggled);
    expect(policyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pol-1' },
        data: { enabled: true },
      }),
    );
  });
});
