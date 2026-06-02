export type Ecosystem =
  | 'npm'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'php'
  | 'ruby'
  | 'dotnet'
  | 'unknown';

export interface EcosystemInfo {
  ecosystem: Ecosystem;
  manifestFile: string | null; // e.g. 'package.json', 'requirements.txt'
  supported: boolean;
  // Every manifest of the primary ecosystem found in the repo (root + workspaces /
  // monorepo packages), repo-relative. Empty for unknown/unsupported ecosystems.
  manifestPaths: string[];
}

export const SUPPORTED_ECOSYSTEMS = new Set<Ecosystem>([
  'npm', 'python', 'go', 'java', 'rust', 'php',
]);

export const MANIFEST_MAP: Array<{ file: string; ecosystem: Ecosystem }> = [
  { file: 'package.json', ecosystem: 'npm' },
  { file: 'requirements.txt', ecosystem: 'python' },
  { file: 'pyproject.toml', ecosystem: 'python' },
  { file: 'setup.py', ecosystem: 'python' },
  { file: 'Pipfile', ecosystem: 'python' },
  { file: 'pom.xml', ecosystem: 'java' },
  { file: 'build.gradle', ecosystem: 'java' },
  { file: 'build.gradle.kts', ecosystem: 'java' },
  { file: 'go.mod', ecosystem: 'go' },
  { file: 'Cargo.toml', ecosystem: 'rust' },
  { file: 'composer.json', ecosystem: 'php' },
  { file: 'Gemfile', ecosystem: 'ruby' },
  { file: 'Gemfile.lock', ecosystem: 'ruby' },
  { file: '*.csproj', ecosystem: 'dotnet' },
  { file: '*.sln', ecosystem: 'dotnet' },
];

const ECOSYSTEM_LABELS: Record<Ecosystem, string> = {
  npm: 'Node.js / npm',
  python: 'Python',
  java: 'Java / Maven / Gradle',
  go: 'Go',
  rust: 'Rust',
  php: 'PHP / Composer',
  ruby: 'Ruby',
  dotnet: '.NET',
  unknown: 'Unbekannt',
};

export function getEcosystemLabel(ecosystem: Ecosystem): string {
  return ECOSYSTEM_LABELS[ecosystem];
}

/**
 * Map a single file path to its ecosystem by basename, or null if it is not a
 * known manifest. Pure: the basis for tree-wide manifest discovery.
 */
/**
 * Precedence of an ecosystem by its first appearance in MANIFEST_MAP. Lower wins.
 * Used to break ties when a repo root carries manifests for several ecosystems
 * (e.g. package.json + go.mod), preserving npm-first ordering.
 */
export function ecosystemPrecedence(ecosystem: Ecosystem): number {
  const i = MANIFEST_MAP.findIndex((m) => m.ecosystem === ecosystem);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

export function manifestEcosystem(filePath: string): Ecosystem | null {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  for (const { file, ecosystem } of MANIFEST_MAP) {
    if (file.startsWith('*')) {
      if (base.endsWith(file.slice(1).toLowerCase())) return ecosystem;
    } else if (base === file.toLowerCase()) {
      return ecosystem;
    }
  }
  return null;
}
