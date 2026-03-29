import { prisma } from "@/lib/prisma";
import type { Period } from "./fail-rate";

const FAILURE_CONCLUSIONS = ["failure", "timed_out", "action_required"];
const DEFAULT_FAIL_RATE_THRESHOLD = 0.2; // 20%
const MIN_RUNS_FOR_DETECTION = 5; // need at least 5 runs to call something flaky

export type FlakySignal = "sha-retry" | "high-fail-rate" | "both";

export interface FlakyJob {
  jobName: string;
  workflowId: string;
  workflowName: string;
  repoFullName: string;
  signal: FlakySignal;
  // Fail-rate signal
  totalRuns: number;
  failedRuns: number;
  failRatePct: number;
  // SHA-retry signal: same commit ran multiple times with mixed results
  shaRetryCount: number; // number of SHAs with mixed conclusions
  shaRetryExamples: string[]; // up to 3 example SHAs
}

/**
 * Detect flaky jobs for a given repo.
 *
 * Two detection strategies:
 * 1. **High fail-rate** (> threshold): Job fails often enough to be unreliable.
 * 2. **SHA-retry pattern**: Same headSha produced both success and failure conclusions
 *    for the same job → non-deterministic, classic flakiness signal.
 *
 * A job must appear in both threshold AND retry to get signal "both".
 */
export async function detectFlakyJobs(
  repoFullName: string,
  options: {
    period?: Period;
    failRateThreshold?: number;
    minRuns?: number;
  } = {}
): Promise<FlakyJob[]> {
  const period = options.period ?? 30;
  const threshold = options.failRateThreshold ?? DEFAULT_FAIL_RATE_THRESHOLD;
  const minRuns = options.minRuns ?? MIN_RUNS_FOR_DETECTION;

  const since = new Date();
  since.setDate(since.getDate() - period);

  const repo = await prisma.repo.findFirst({
    where: { fullName: repoFullName },
    include: {
      workflows: {
        include: {
          runs: {
            where: { runCreatedAt: { gte: since }, status: "completed" },
            select: {
              headSha: true,
              jobs: {
                select: { name: true, conclusion: true },
              },
            },
          },
        },
      },
    },
  });

  if (!repo) return [];

  const flakyJobs: FlakyJob[] = [];

  for (const wf of repo.workflows) {
    // Aggregate per-job data
    type JobData = {
      total: number;
      failed: number;
      // sha → set of conclusions seen
      shaConclusions: Map<string, Set<string>>;
    };

    const jobMap = new Map<string, JobData>();

    for (const run of wf.runs) {
      for (const job of run.jobs) {
        if (!job.conclusion) continue;
        let data = jobMap.get(job.name);
        if (!data) {
          data = { total: 0, failed: 0, shaConclusions: new Map() };
          jobMap.set(job.name, data);
        }
        data.total++;
        if (FAILURE_CONCLUSIONS.includes(job.conclusion)) data.failed++;

        // Track conclusions per SHA
        if (run.headSha) {
          let shaSet = data.shaConclusions.get(run.headSha);
          if (!shaSet) {
            shaSet = new Set();
            data.shaConclusions.set(run.headSha, shaSet);
          }
          shaSet.add(job.conclusion);
        }
      }
    }

    for (const [jobName, data] of jobMap.entries()) {
      if (data.total < minRuns) continue;

      const failRate = data.failed / data.total;
      const isHighFailRate = failRate > threshold;

      // SHA-retry: SHAs where we saw BOTH a success and at least one failure
      const flakyShAs = Array.from(data.shaConclusions.entries()).filter(
        ([, conclusions]) => {
          const hasSuccess = conclusions.has("success");
          const hasFailure = [...conclusions].some((c) => FAILURE_CONCLUSIONS.includes(c));
          return hasSuccess && hasFailure;
        }
      );
      const isShaRetry = flakyShAs.length > 0;

      if (!isHighFailRate && !isShaRetry) continue;

      const signal: FlakySignal =
        isHighFailRate && isShaRetry ? "both" : isHighFailRate ? "high-fail-rate" : "sha-retry";

      flakyJobs.push({
        jobName,
        workflowId: wf.id,
        workflowName: wf.name,
        repoFullName,
        signal,
        totalRuns: data.total,
        failedRuns: data.failed,
        failRatePct: Math.round(failRate * 1000) / 10,
        shaRetryCount: flakyShAs.length,
        shaRetryExamples: flakyShAs.slice(0, 3).map(([sha]) => sha.substring(0, 8)),
      });
    }
  }

  // Sort: "both" first, then by failRatePct desc
  return flakyJobs.sort((a, b) => {
    if (a.signal === "both" && b.signal !== "both") return -1;
    if (b.signal === "both" && a.signal !== "both") return 1;
    return b.failRatePct - a.failRatePct;
  });
}
