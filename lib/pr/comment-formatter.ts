import type { Advisory } from '@prisma/client';

export function formatCVEComment(
  repoFullName: string,
  newAdvisories: Advisory[],
  totalCount: number,
  riskScore: number,
): string {
  if (newAdvisories.length === 0) {
    return `## 🔍 depsight Security Scan\n\n✅ **Keine neuen CVEs** durch diesen PR eingeführt.\n\n_Risk Score: ${riskScore}/100 | Gesamt: ${totalCount} CVEs_`;
  }

  const critical = newAdvisories.filter((a) => a.severity === 'CRITICAL');
  const high = newAdvisories.filter((a) => a.severity === 'HIGH');
  const medium = newAdvisories.filter((a) => a.severity === 'MEDIUM');
  const low = newAdvisories.filter((a) => a.severity === 'LOW');

  const severityBadge = (sev: string) => {
    switch (sev) {
      case 'CRITICAL': return '🔴 KRITISCH';
      case 'HIGH': return '🟠 HOCH';
      case 'MEDIUM': return '🟡 MITTEL';
      case 'LOW': return '🟢 NIEDRIG';
      default: return '⚪ UNBEKANNT';
    }
  };

  const summaryLine = [
    critical.length > 0 ? `🔴 ${critical.length} Kritisch` : null,
    high.length > 0 ? `🟠 ${high.length} Hoch` : null,
    medium.length > 0 ? `🟡 ${medium.length} Mittel` : null,
    low.length > 0 ? `🟢 ${low.length} Niedrig` : null,
  ].filter(Boolean).join(' · ');

  let comment = `## 🔍 depsight Security Scan\n\n`;
  comment += `⚠️ **${newAdvisories.length} neue CVE(s)** in diesem PR erkannt!\n\n`;
  comment += `**${summaryLine}** | Risk Score: \`${riskScore}/100\`\n\n`;
  comment += `---\n\n`;

  // List new advisories
  const top = newAdvisories.slice(0, 10); // max 10 in comment
  for (const a of top) {
    comment += `### ${severityBadge(a.severity)} ${a.ghsaId}`;
    if (a.cveId) comment += ` (${a.cveId})`;
    comment += `\n`;
    comment += `**Paket:** \`${a.packageName}\` (${a.ecosystem})`;
    if (a.vulnerableRange) comment += ` · Betroffen: \`${a.vulnerableRange}\``;
    if (a.fixedVersion) comment += ` · ✅ Fix: \`${a.fixedVersion}\``;
    comment += `\n`;
    comment += `> ${a.summary}\n`;
    if (a.url) comment += `\n[Details ansehen](${a.url})\n`;
    comment += `\n`;
  }

  if (newAdvisories.length > 10) {
    comment += `_... und ${newAdvisories.length - 10} weitere CVEs. [Alle ansehen auf depsight](#)_\n\n`;
  }

  comment += `---\n`;
  comment += `_Gescannt von [depsight](https://github.com/LanNguyenSi/depsight) · ${new Date().toLocaleDateString('de-DE')}_`;

  return comment;
}
