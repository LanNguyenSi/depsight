import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';

// CycloneDX 1.4 JSON schema types
export interface CycloneDXComponent {
  type: 'library' | 'framework' | 'application' | 'container' | 'device' | 'firmware' | 'file';
  'bom-ref': string;
  name: string;
  version?: string;
  purl?: string;
  licenses?: Array<{ license: { id?: string; name?: string } }>;
  properties?: Array<{ name: string; value: string }>;
}

export interface CycloneDXVulnerability {
  id: string;
  source?: { name: string; url?: string };
  ratings?: Array<{ severity: string; source?: { name: string } }>;
  description?: string;
  affects?: Array<{ ref: string }>;
  properties?: Array<{ name: string; value: string }>;
}

export interface CycloneDXBOM {
  bomFormat: 'CycloneDX';
  specVersion: '1.4';
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools?: Array<{ vendor: string; name: string; version: string }>;
    component?: {
      type: 'application';
      name: string;
      version?: string;
    };
  };
  components: CycloneDXComponent[];
  vulnerabilities?: CycloneDXVulnerability[];
}

/**
 * Generate a Package URL (PURL) per the PURL spec (https://github.com/package-url/purl-spec).
 * Accepts both depsight-internal and GitHub/OSV ecosystem vocabulary (e.g. 'pip', 'packagist').
 * Each path segment is encoded separately so namespace separators ('/' for golang/composer/npm
 * scoped packages, ':' for maven group:artifact) are preserved as literal characters.
 */
export function toPurl(ecosystem: string, packageName: string, version?: string): string {
  const eco = ecosystem.toLowerCase();
  // Normalize to PURL type vocabulary — accept both depsight and GitHub/OSV vocabulary
  const type =
    eco === 'npm' ? 'npm' :
    eco === 'pypi' || eco === 'python' || eco === 'pip' ? 'pypi' :
    eco === 'maven' || eco === 'java' ? 'maven' :
    eco === 'cargo' || eco === 'rust' || eco === 'crates.io' ? 'cargo' :
    eco === 'composer' || eco === 'php' || eco === 'packagist' ? 'composer' :
    eco === 'golang' || eco === 'go' ? 'golang' :
    eco === 'gem' || eco === 'rubygems' || eco === 'ruby' ? 'gem' :
    eco === 'nuget' || eco === 'dotnet' ? 'nuget' :
    'generic';

  // Build the namespaced path — encode each segment separately to preserve separators
  let namePath: string;
  if (type === 'maven' && packageName.includes(':')) {
    // maven: groupId:artifactId -> pkg:maven/<group>/<artifact>
    const colonIdx = packageName.indexOf(':');
    const namespace = packageName.slice(0, colonIdx);
    const artifact = packageName.slice(colonIdx + 1);
    namePath = `${encodeURIComponent(namespace)}/${encodeURIComponent(artifact)}`;
  } else if (packageName.includes('/')) {
    // golang, composer, scoped npm (e.g. @scope/name): encode each segment, preserve '/'
    namePath = packageName.split('/').map(encodeURIComponent).join('/');
  } else {
    // Simple name with no separators
    namePath = encodeURIComponent(packageName);
  }

  const base = `pkg:${type}/${namePath}`;
  return version ? `${base}@${encodeURIComponent(version)}` : base;
}

function severityToCycloneDX(severity: string): string {
  switch (severity.toUpperCase()) {
    case 'CRITICAL': return 'critical';
    case 'HIGH': return 'high';
    case 'MEDIUM': return 'medium';
    case 'LOW': return 'low';
    default: return 'unknown';
  }
}

function generateUUID(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return `urn:uuid:${[8, 4, 4, 4, 12].map((n) => Array.from({ length: n }, hex).join('')).join('-')}`;
}

export async function generateSBOM(
  userId: string,
  repoId: string,
): Promise<CycloneDXBOM> {
  const repo = await prisma.repo.findFirst({
    where: { id: repoId, userId, tracked: true },
  });

  if (!repo) throw new Error('Repository not found or access denied');

  // Get latest scan of each type (CVE, license, deps create separate scan records)
  const [cveScan, licenseScan, depsScan] = await Promise.all([
    prisma.scan.findFirst({
      where: { repoId, status: 'COMPLETED', cvePayload: { not: Prisma.DbNull } },
      orderBy: { scannedAt: 'desc' },
      select: {
        ecosystem: true,
        advisories: true,
      },
    }),
    prisma.scan.findFirst({
      where: { repoId, status: 'COMPLETED', licenseCount: { gt: 0 } },
      orderBy: { scannedAt: 'desc' },
      include: { licenses: true },
    }),
    prisma.scan.findFirst({
      where: { repoId, status: 'COMPLETED', dependencies: { some: {} } },
      orderBy: { scannedAt: 'desc' },
      include: { dependencies: { orderBy: { name: 'asc' } } },
    }),
  ]);

  // Merge results from the different scan types
  const scan = {
    advisories: cveScan?.advisories ?? [],
    licenses: licenseScan?.licenses ?? [],
    dependencies: depsScan?.dependencies ?? [],
  };

  // Resolve repo ecosystem: scan.ecosystem > first advisory's ecosystem > 'generic'
  const repoEcosystem: string =
    cveScan?.ecosystem ??
    cveScan?.advisories?.[0]?.ecosystem ??
    'generic';

  // Build components from dependencies
  const components: CycloneDXComponent[] = [];
  const componentRefs = new Map<string, string>(); // name → bom-ref

  if (scan.dependencies.length > 0) {
    for (const dep of scan.dependencies) {
      const ref = `dep-${dep.id}`;
      componentRefs.set(dep.name, ref);

      // Find license for this dep
      const licenseResult = scan.licenses.find((l) => l.packageName === dep.name);

      const component: CycloneDXComponent = {
        type: 'library',
        'bom-ref': ref,
        name: dep.name,
        version: dep.installedVersion || undefined,
        purl: toPurl(repoEcosystem, dep.name, dep.installedVersion),
        properties: [],
      };

      if (licenseResult?.license && licenseResult.license !== 'UNKNOWN') {
        component.licenses = [{ license: { id: licenseResult.license } }];
      }

      if (dep.status !== 'UNKNOWN') {
        component.properties!.push({ name: 'depsight:status', value: dep.status });
      }
      if (dep.latestVersion) {
        component.properties!.push({ name: 'depsight:latestVersion', value: dep.latestVersion });
      }
      if (dep.ageInDays !== null) {
        component.properties!.push({ name: 'depsight:ageInDays', value: String(dep.ageInDays) });
      }
      if (dep.isDeprecated) {
        component.properties!.push({ name: 'depsight:deprecated', value: 'true' });
      }

      // Remove empty properties array
      if (component.properties!.length === 0) delete component.properties;

      components.push(component);
    }
  }

  // If no deps from scan, at least include from license results
  if (components.length === 0 && scan.licenses.length > 0) {
    for (const lic of scan.licenses) {
      const ref = `lic-${lic.id}`;
      componentRefs.set(lic.packageName, ref);
      components.push({
        type: 'library',
        'bom-ref': ref,
        name: lic.packageName,
        version: lic.version || undefined,
        purl: toPurl(repoEcosystem, lic.packageName, lic.version ?? undefined),
        ...(lic.license && lic.license !== 'UNKNOWN'
          ? { licenses: [{ license: { id: lic.license } }] }
          : {}),
      });
    }
  }

  // Build vulnerabilities from advisories
  const vulnerabilities: CycloneDXVulnerability[] = [];

  if (scan.advisories.length > 0) {
    for (const advisory of scan.advisories) {
      const vuln: CycloneDXVulnerability = {
        id: advisory.cveId ?? advisory.ghsaId,
        source: advisory.source === 'osv'
          ? {
              name: 'OSV',
              url: `https://osv.dev/vulnerability/${advisory.ghsaId}`,
            }
          : {
              name: 'GitHub Advisory Database',
              url: advisory.url ?? undefined,
            },
        ratings: [{
          severity: severityToCycloneDX(advisory.severity),
          source: { name: advisory.cveId ? 'NVD' : 'GitHub' },
        }],
        description: advisory.summary,
        properties: [
          { name: 'depsight:ghsaId', value: advisory.ghsaId },
          { name: 'depsight:packageName', value: advisory.packageName },
          { name: 'depsight:ecosystem', value: advisory.ecosystem },
          ...(advisory.fixedVersion
            ? [{ name: 'depsight:fixedVersion', value: advisory.fixedVersion }]
            : []),
        ],
      };

      // Link to affected component
      const ref = componentRefs.get(advisory.packageName);
      if (ref) {
        vuln.affects = [{ ref }];
      }

      vulnerabilities.push(vuln);
    }
  }

  const bom: CycloneDXBOM = {
    bomFormat: 'CycloneDX',
    specVersion: '1.4',
    serialNumber: generateUUID(),
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{
        vendor: 'depsight',
        name: 'depsight',
        version: '1.0.0',
      }],
      component: {
        type: 'application',
        name: repo.fullName,
        version: repo.defaultBranch,
      },
    },
    components,
    ...(vulnerabilities.length > 0 ? { vulnerabilities } : {}),
  };

  return bom;
}
