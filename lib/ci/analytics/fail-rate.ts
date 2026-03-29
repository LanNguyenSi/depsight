import { prisma } from "@/lib/prisma";

export type Period = 1 | 7 | 30;

export interface FailRateResult {
  name: string;
  totalRuns: number;
  failedRuns: number;
  failRate: number; // 0–1
  failRatePct: number; // 0–100, rounded to 1 decimal
}

export interface WorkflowFailRate extends FailRateResult {
  workflowId: string;
  repoFullName: string;
  jobs: JobFailRate[];
}

export interface JobFailRate extends FailRateResult {
  jobName: string;
}

/** Conclusions considered as failures */
const FAILURE_CONCLUSIONS = ["failure", "timed_out", "action_required"];

function sinceDate(days: Period): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function toRate(failed: number, total: number): Pick<FailRateResult, "failRate" | "failRatePct"> {
  if (total === 0) return { failRate: 0, failRatePct: 0 };
  const rate = failed / total;
  return { failRate: rate, failRatePct: Math.round(rate * 1000) / 10 };
}

/**
 * Get fail rate per workflow for a repo over a given period.
 * Includes per-job breakdown.
 */
export async function getWorkflowFailRates(
  repoFullName: string,
  period: Period = 30
): Promise<WorkflowFailRate[]> {
  const since = sinceDate(period);

  const repo = await prisma.repo.findFirst({
    where: { fullName: repoFullName },
    include: { workflows: { include: { runs: { where: { runCreatedAt: { gte: since } }, include: { jobs: true } } } } },
  });

  if (!repo) return [];

  return repo.workflows.map((wf) => {
    const runs = wf.runs;
    const totalRuns = runs.length;
    const failedRuns = runs.filter((r) => r.conclusion && FAILURE_CONCLUSIONS.includes(r.conclusion)).length;

    // Aggregate job fail rates
    const jobMap = new Map<string, { total: number; failed: number }>();
    for (const run of runs) {
      for (const job of run.jobs) {
        const entry = jobMap.get(job.name) ?? { total: 0, failed: 0 };
        entry.total++;
        if (job.conclusion && FAILURE_CONCLUSIONS.includes(job.conclusion)) entry.failed++;
        jobMap.set(job.name, entry);
      }
    }

    const jobs: JobFailRate[] = Array.from(jobMap.entries()).map(([name, { total, failed }]) => ({
      jobName: name,
      name,
      totalRuns: total,
      failedRuns: failed,
      ...toRate(failed, total),
    }));

    return {
      workflowId: wf.id,
      repoFullName,
      name: wf.name,
      totalRuns,
      failedRuns,
      jobs,
      ...toRate(failedRuns, totalRuns),
    };
  });
}

/**
 * Get fail rates for all workflows across all repos.
 */
export async function getAllFailRates(period: Period = 30): Promise<WorkflowFailRate[]> {
  const repos = await prisma.repo.findMany({ select: { fullName: true } });
  const results: WorkflowFailRate[] = [];
  for (const repo of repos) {
    const rates = await getWorkflowFailRates(repo.fullName, period);
    results.push(...rates);
  }
  return results;
}

/**
 * Fail rates for a specific workflow across periods (1/7/30 days).
 */
export async function getWorkflowFailRateMultiPeriod(workflowId: string): Promise<
  Record<Period, Omit<WorkflowFailRate, "jobs">>
> {
  const wf = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: { repo: true },
  });
  if (!wf) throw new Error(`Workflow ${workflowId} not found`);

  const periods: Period[] = [1, 7, 30];
  const result: Partial<Record<Period, Omit<WorkflowFailRate, "jobs">>> = {};

  for (const period of periods) {
    const since = sinceDate(period);
    const runs = await prisma.workflowRun.findMany({
      where: { workflowId, runCreatedAt: { gte: since } },
      select: { conclusion: true },
    });
    const totalRuns = runs.length;
    const failedRuns = runs.filter((r) => r.conclusion && FAILURE_CONCLUSIONS.includes(r.conclusion)).length;
    result[period] = {
      workflowId,
      repoFullName: wf.repo.fullName,
      name: wf.name,
      totalRuns,
      failedRuns,
      ...toRate(failedRuns, totalRuns),
    };
  }

  return result as Record<Period, Omit<WorkflowFailRate, "jobs">>;
}
