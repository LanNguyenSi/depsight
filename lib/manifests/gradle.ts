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
 *
 * Declarations inside `constraints { }` blocks are not dependencies and are
 * skipped. Known limitations (all yield no entry rather than a wrong one):
 * map form only in the order group, name, version; only the first coordinate
 * of a call with several; `testFixtures(...)`, triple-quoted coordinates, and
 * configurations other than the five above. Braces inside strings within a
 * `constraints { }` block can end the block early, and an unclosed block hides
 * everything after it.
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

/**
 * Remove line and block comments while leaving string literals intact, so a
 * `//` or `/*` inside '...', "..." or a triple-quoted string is kept as text.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source.startsWith(quote, j)) {
          j += quote.length;
          break;
        }
        if (!triple && source[j] === '\n') break;
        j++;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop `constraints { ... }` blocks (brace-matched); they pin versions, they do not declare dependencies. */
function stripConstraintBlocks(text: string): string {
  const opener = /\bconstraints\s*\{/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(text)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    out += text.slice(last, m.index);
    last = j;
    opener.lastIndex = j;
  }
  return out + text.slice(last);
}

/** True when the version is a literal Gradle would use as written. */
export function isLiteralVersion(version: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) return false; // $, {, +, [, (, comma, spaces
  if (!/[A-Za-z0-9]/.test(version)) return false; // only separators, e.g. "-" or ".."
  if (version.startsWith('latest.')) return false;
  return true;
}

/** True when a group or artifact id is written literally (no interpolation or other expressions). */
function isLiteralId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && /[A-Za-z0-9]/.test(id);
}

/** Parse one Gradle build file into dependencies with literal versions, in source order. */
export function parseGradleDependencies(source: string): GradleDependency[] {
  const text = stripConstraintBlocks(stripComments(source));
  const found: Array<{ index: number; dep: GradleDependency }> = [];

  for (const m of text.matchAll(CALL_FORM)) {
    // g:a:v[:classifier][@extension]
    const coordinate = m[2].split('@')[0];
    const parts = coordinate.split(':');
    if (parts.length < 3) continue; // no version (for example g:a)
    const [groupId, artifactId, version] = parts;
    if (!isLiteralId(groupId) || !isLiteralId(artifactId) || !isLiteralVersion(version)) continue;
    found.push({ index: m.index ?? 0, dep: { groupId, artifactId, version } });
  }

  for (const m of text.matchAll(MAP_FORM)) {
    const groupId = m[2];
    const artifactId = m[4];
    const version = m[6];
    if (!isLiteralId(groupId) || !isLiteralId(artifactId) || version === undefined || !isLiteralVersion(version)) continue;
    found.push({ index: m.index ?? 0, dep: { groupId, artifactId, version } });
  }

  return found.sort((a, b) => a.index - b.index).map((f) => f.dep);
}
