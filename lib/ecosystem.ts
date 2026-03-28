import { createGitHubClient } from '@/lib/github';

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
}

const MANIFEST_MAP: Array<{ file: string; ecosystem: Ecosystem }> = [
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

export async function detectEcosystem(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<EcosystemInfo> {
  const octokit = createGitHubClient(accessToken);

  try {
    const { data: rootContents } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '',
    });

    if (!Array.isArray(rootContents)) {
      return { ecosystem: 'unknown', manifestFile: null, supported: false };
    }

    const fileNames = rootContents
      .filter((f) => f.type === 'file')
      .map((f) => f.name.toLowerCase());

    for (const { file, ecosystem } of MANIFEST_MAP) {
      // Wildcard patterns (*.csproj etc.)
      if (file.startsWith('*')) {
        const ext = file.slice(1); // e.g. '.csproj'
        if (fileNames.some((f) => f.endsWith(ext))) {
          return { ecosystem, manifestFile: file, supported: ecosystem === 'npm' };
        }
      } else if (fileNames.includes(file.toLowerCase())) {
        return { ecosystem, manifestFile: file, supported: ecosystem === 'npm' };
      }
    }
  } catch {
    // Can't read root — treat as unknown
  }

  return { ecosystem: 'unknown', manifestFile: null, supported: false };
}
