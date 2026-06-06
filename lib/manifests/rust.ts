import { fetchManifestContents, type Octokit } from '@/lib/manifest-discovery';

export interface CargoDep {
  name: string;
  version: string;
}

const DEFAULT_PATHS = ['Cargo.toml'];

/**
 * Parse a Cargo.toml file to extract dependencies.
 * Handles formats:
 *   serde = "1.0"
 *   serde = { version = "1.0", features = [...] }
 *   tokio = { version = "1", ... }
 */
export function parseCargoToml(content: string): CargoDep[] {
  const deps: CargoDep[] = [];
  const lines = content.split('\n');

  let inDepsSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect section headers
    if (line.startsWith('[')) {
      inDepsSection =
        line === '[dependencies]' ||
        line === '[dev-dependencies]';
      continue;
    }

    if (!inDepsSection || !line || line.startsWith('#')) continue;

    // Match: name = "version"
    const simpleMatch = /^([a-zA-Z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (simpleMatch) {
      deps.push({ name: simpleMatch[1], version: simpleMatch[2] });
      continue;
    }

    // Match: name = { version = "version", ... }
    const tableMatch = /^([a-zA-Z0-9_-]+)\s*=\s*\{.*?version\s*=\s*"([^"]*)"/.exec(line);
    if (tableMatch) {
      deps.push({ name: tableMatch[1], version: tableMatch[2] });
    }
  }

  return deps;
}

/**
 * Read every discovered Cargo.toml (workspace root + member crates) and union
 * their dependencies. Deduped by crate name with first-seen (root-first) wins.
 * A virtual workspace root (only `[workspace]`, no `[dependencies]`) simply
 * contributes nothing. Pure path-only `{ path = "../x" }` member deps carry no
 * version and are already skipped by the parser.
 *
 * Known limitation: workspace dependency inheritance is not resolved. Crates
 * that declare `serde = { workspace = true }` against a root
 * `[workspace.dependencies]` table contribute no version here and are dropped
 * by the parser. Resolving that is tracked as a follow-up.
 */
export async function collectRustDeps(
  octokit: Octokit,
  owner: string,
  repo: string,
  manifestPaths: string[] = [],
): Promise<CargoDep[]> {
  const paths = manifestPaths.length > 0 ? manifestPaths : DEFAULT_PATHS;
  const contents = await fetchManifestContents(octokit, owner, repo, paths);

  const byName = new Map<string, CargoDep>();
  for (const { content } of contents) {
    for (const dep of parseCargoToml(content)) {
      if (!byName.has(dep.name)) byName.set(dep.name, dep);
    }
  }

  return [...byName.values()];
}
