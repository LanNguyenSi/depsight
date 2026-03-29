import { createGitHubClient } from '@/lib/github';
import { fetchRepoAdvisories } from '@/lib/cve/github-advisories';
import { prisma } from '@/lib/prisma';
import { formatCVEComment } from './comment-formatter';

const DEPSIGHT_COMMENT_MARKER = '<!-- depsight-cve-scan -->';

export async function scanPRAndComment(
  accessToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  userId: string,
): Promise<{ commented: boolean; newCVECount: number; commentUrl: string | null }> {
  const octokit = createGitHubClient(accessToken);

  // Get DB repo
  const dbRepo = await prisma.repo.findFirst({
    where: { owner, name: repo, userId, tracked: true },
  });

  // Scan for current CVEs
  const scanResult = await fetchRepoAdvisories(accessToken, owner, repo);

  // Find previous scan to detect *new* CVEs
  let previousGhsaIds = new Set<string>();
  if (dbRepo) {
    const prevScan = await prisma.scan.findFirst({
      where: { repoId: dbRepo.id, status: 'COMPLETED' },
      orderBy: { scannedAt: 'desc' },
      include: { advisories: { select: { ghsaId: true } } },
    });
    if (prevScan) {
      previousGhsaIds = new Set(prevScan.advisories.map((a) => a.ghsaId));
    }
  }

  // Determine new advisories (not seen in previous scan)
  const newAdvisories = scanResult.advisories.filter(
    (a) => !previousGhsaIds.has(a.ghsaId),
  );

  // Check for existing depsight comment on this PR
  let existingCommentId: number | null = null;
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    const existing = comments.find((c) => c.body?.includes(DEPSIGHT_COMMENT_MARKER));
    if (existing) existingCommentId = existing.id;
  } catch {
    // Can't read comments, proceed anyway
  }

  const commentBody = DEPSIGHT_COMMENT_MARKER + '\n' + formatCVEComment(
    `${owner}/${repo}`,
    // We need Advisory type — convert from GitHubAdvisory
    newAdvisories.map((a, i) => ({
      id: `temp-${i}`,
      scanId: '',
      ghsaId: a.ghsaId,
      cveId: a.cveId,
      severity: a.severity as string,
      summary: a.summary,
      packageName: a.packageName,
      ecosystem: a.ecosystem,
      vulnerableRange: a.vulnerableRange,
      fixedVersion: a.fixedVersion,
      publishedAt: a.publishedAt,
      url: a.url,
    })) as Parameters<typeof formatCVEComment>[1],
    scanResult.counts.total,
    scanResult.riskScore,
  );

  let commentUrl: string | null = null;

  try {
    if (existingCommentId) {
      // Update existing comment
      const { data } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingCommentId,
        body: commentBody,
      });
      commentUrl = data.html_url;
    } else {
      // Create new comment
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: commentBody,
      });
      commentUrl = data.html_url;
    }
  } catch (err) {
    console.error('Failed to post PR comment:', err);
    // Non-fatal — return result anyway
  }

  return {
    commented: commentUrl !== null,
    newCVECount: newAdvisories.length,
    commentUrl,
  };
}
