import crypto from 'crypto';
import type { Advisory } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export type NotificationEvent =
  | 'cve.critical'
  | 'cve.high'
  | 'scan.completed';

export interface CVENotificationPayload {
  event: NotificationEvent;
  repoFullName: string;
  repoId: string;
  scanId: string;
  riskScore: number;
  newAdvisories: Array<{
    ghsaId: string;
    cveId: string | null;
    severity: string;
    summary: string;
    packageName: string;
    fixedVersion: string | null;
    url: string | null;
  }>;
  scannedAt: string;
}

// ─── Webhook ────────────────────────────────────────────────────────────────

function signPayload(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliverWebhook(
  url: string,
  secret: string | null,
  payload: CVENotificationPayload,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'depsight/1.0',
    'X-depsight-Event': payload.event,
  };

  if (secret) {
    headers['X-depsight-Signature'] = signPayload(secret, body);
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

// ─── Slack ──────────────────────────────────────────────────────────────────

function buildSlackMessage(payload: CVENotificationPayload): object {
  const criticalCount = payload.newAdvisories.filter((a) => a.severity === 'CRITICAL').length;
  const highCount = payload.newAdvisories.filter((a) => a.severity === 'HIGH').length;

  const emoji = criticalCount > 0 ? '🚨' : '⚠️';
  const text = `${emoji} *depsight Security Alert* — ${payload.repoFullName}`;

  const fields = [
    { type: 'mrkdwn', text: `*CVEs gefunden:* ${payload.newAdvisories.length}` },
    { type: 'mrkdwn', text: `*Risk Score:* ${payload.riskScore}/100` },
  ];
  if (criticalCount > 0) {
    fields.push({ type: 'mrkdwn', text: `*🔴 Kritisch:* ${criticalCount}` });
  }
  if (highCount > 0) {
    fields.push({ type: 'mrkdwn', text: `*🟠 Hoch:* ${highCount}` });
  }

  // Show top 3 advisories
  const topCVEs = payload.newAdvisories.slice(0, 3).map((a) => {
    const sev = a.severity === 'CRITICAL' ? '🔴' : a.severity === 'HIGH' ? '🟠' : '🟡';
    return `${sev} \`${a.packageName}\` — ${a.summary.slice(0, 80)}${a.summary.length > 80 ? '…' : ''}`;
  }).join('\n');

  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${emoji} Security Alert: ${payload.repoFullName}` } },
      { type: 'section', fields },
      ...(topCVEs ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Neue Schwachstellen:*\n${topCVEs}` },
      }] : []),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `depsight · ${new Date(payload.scannedAt).toLocaleString('de-DE')}` }],
      },
    ],
  };
}

async function deliverSlack(
  webhookUrl: string,
  channel: string | null,
  payload: CVENotificationPayload,
): Promise<{ ok: boolean; error?: string }> {
  const message = buildSlackMessage(payload);
  const body = JSON.stringify({ ...message, ...(channel ? { channel } : {}) });

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0,
};

export async function notifyForScan(
  userId: string,
  repoId: string,
  repoFullName: string,
  scanId: string,
  riskScore: number,
  newAdvisories: Advisory[],
): Promise<void> {
  if (newAdvisories.length === 0) return;

  const maxSeverityValue = Math.max(
    ...newAdvisories.map((a) => SEVERITY_ORDER[a.severity] ?? 0),
  );
  const event: NotificationEvent =
    maxSeverityValue >= SEVERITY_ORDER.CRITICAL ? 'cve.critical' : 'cve.high';

  const payload: CVENotificationPayload = {
    event,
    repoFullName,
    repoId,
    scanId,
    riskScore,
    newAdvisories: newAdvisories.map((a) => ({
      ghsaId: a.ghsaId,
      cveId: a.cveId,
      severity: a.severity,
      summary: a.summary,
      packageName: a.packageName,
      fixedVersion: a.fixedVersion,
      url: a.url,
    })),
    scannedAt: new Date().toISOString(),
  };

  // Deliver webhooks
  const webhooks = await prisma.webhookConfig.findMany({
    where: { userId, enabled: true },
  });

  await Promise.allSettled(
    webhooks
      .filter((wh) => wh.events.includes(event) || wh.events.includes('scan.completed'))
      .map((wh) => deliverWebhook(wh.url, wh.secret, payload)),
  );

  // Deliver Slack
  const slack = await prisma.slackConfig.findUnique({
    where: { userId },
  });

  if (slack?.enabled) {
    const slackSeverityValue = SEVERITY_ORDER[slack.minSeverity] ?? 0;
    if (maxSeverityValue >= slackSeverityValue) {
      await deliverSlack(slack.webhookUrl, slack.channel, payload);
    }
  }
}
