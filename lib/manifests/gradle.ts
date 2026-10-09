/**
 * Minimal Gradle build-file parser (Groovy `build.gradle` and Kotlin DSL
 * `build.gradle.kts`). It reads dependency declarations of the configurations
 * below in call form (`implementation 'g:a:v'`, `implementation("g:a:v")`)
 * and map form (`implementation group: 'g', name: 'a', version: 'v'`, Kotlin
 * `implementation(group = "g", name = "a", version = "v")`).
 *
 * Only versions written literally in the file are returned. Anything Gradle
 * would resolve at build time is skipped rather than guessed: a missing
 * version (platform/BOM imports), `$var` / `${var}` interpolation, version
 * catalogs (`libs.x`), `project(...)` / `files(...)` / `fileTree(...)`, and
 * dynamic versions (`1.+`, `latest.release`, ranges like `[1.0,2.0)`).
 */

export interface GradleDependency {
  groupId: string;
  artifactId: string;
  version: string;
}

const CONFIGURATIONS = 'implementation|api|compileOnly|runtimeOnly|testImplementation';

// `implementation 'g:a:v'`, `implementation("g:a:v")`; the quote must follow
// the configuration name (optionally after `(`), so `platform(...)`,
// `project(...)`, `files(...)` and catalog references never match.
const CALL_FORM = new RegExp(String.raw`\b(?:${CONFIGURATIONS})\s*\(?\s*(['\"])([^'\"\n]+)\1`, 'g');

// `implementation group: 'g', name: 'a', version: 'v'` (Groovy) and
// `implementation(group = "g", name = "a", version = "v")` (Kotlin).
const MAP_FORM = new RegExp(
  String.raw`\b(?:${CONFIGURATIONS})\s*\(?\s*group\s*[:=]\s*(['\"])([^'\"\n]+)\1\s*,\s*name\s*[:=]\s*(['\"])([^'\"\n]+)\3(?:\s*,\s*version\s*[:=]\s*(['\"])([^'\"\n]+)\5)?`,
  'g',
);

/** Remove block comments and line comments (a `//` preceded by `:` is a URL scheme, not a comment). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** True when the version is a literal Gradle would use as written. */
export function isLiteralVersion(version: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) return false; // $, {, +, [, (, comma, spaces
  if (version.startsWith('latest.')) return false;
  return true;
}

/** Parse one Gradle build file into dependencies with literal versions, in source order. */
export function parseGradleDependencies(source: string): GradleDependency[] {
  const text = stripComments(source);
  const found: Array<{ index: number; dep: GradleDependency }> = [];

  for (const m of text.matchAll(CALL_FORM)) {
    // g:a:v[:classifier][@extension]
    const coordinate = m[2].split('@')[0];
    const parts = coordinate.split(':');
    if (parts.length < 3) continue; // no version (for example g:a)
    const [groupId, artifactId, version] = parts;
    if (!groupId || !artifactId || !isLiteralVersion(version)) continue;
    found.push({ index: m.index ?? 0, dep: { groupId, artifactId, version } });
  }

  for (const m of text.matchAll(MAP_FORM)) {
    const groupId = m[2];
    const artifactId = m[4];
    const version = m[6];
    if (version === undefined || !isLiteralVersion(version)) continue;
    found.push({ index: m.index ?? 0, dep: { groupId, artifactId, version } });
  }

  return found.sort((a, b) => a.index - b.index).map((f) => f.dep);
}
