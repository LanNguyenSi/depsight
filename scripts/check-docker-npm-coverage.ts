#!/usr/bin/env tsx
/**
 * Standalone check for the npm 10 "edgesOut" crash class in Docker builds.
 *
 * Usage:
 *   npx tsx scripts/check-docker-npm-coverage.ts [--json] <repoDir>...
 *   npx tsx scripts/check-docker-npm-coverage.ts --help
 *
 * Background: npm 10.x (bundled with node:18, node:20 and node:22) crashes
 * with "Cannot read properties of null (reading 'edgesOut')" when it resolves
 * a project WITHOUT a lockfile and the manifest contains
 * `@vitest/coverage-v8`. CI stays green because CI uses `npm ci` with a
 * lockfile, while the Docker build breaks. This script flags only the
 * combination of all three ingredients below. It reads files only: it runs no
 * docker, no npm and no network.
 *
 * Incident reference (negative control in the tests): project-pilot,
 * backend/Dockerfile at commit 5e1ba8c (`FROM node:22-alpine AS builder`,
 * `WORKDIR /app`, `COPY package.json ./`, `RUN npm install`) with
 * `"@vitest/coverage-v8": "4.1.8"` in backend/package.json. The fix
 * (b737de0) added `RUN npm install -g npm@11` before the install.
 *
 * Rules
 * -----
 * Input: one or more repository directories. Per repository, Dockerfiles are
 * searched recursively (file name `Dockerfile`, `Dockerfile.*` or
 * `*.Dockerfile`; `node_modules`, `.git` and `.worktrees` are skipped). The
 * build context of a Dockerfile is the directory that contains it.
 *
 * Parsing: line continuations (`\`) are joined, comment lines dropped. Leading
 * RUN flags (`--mount=...`, `--network=...`) are ignored. A RUN heredoc
 * marker is a whitespace-separated word outside quotes that is exactly
 * `<<WORD`, `<<-WORD`, `<<'WORD'` or `<<"WORD"` (BuildKit style), so
 * `"x<<y"`, `$((a<<b))`, `'s/<<HEAD//'` and a here-string `<<<word` are no
 * markers. The body lines up to the delimiter line belong to that RUN (they
 * never become instructions) and an install in them is reported at the RUN
 * start line. A body is read as shell text only when the command before the
 * marker is empty (`RUN <<EOF`), or a shell (`sh`, `bash`, `ash`, `dash`)
 * reached after skipping wrapper commands (`env` with `VAR=val` and its
 * flags, `sudo` with its flags, `command`, `exec`, `nice`, `time`) and
 * `VAR=val` prefixes, with only option flags (`-e`, `-x`, `-o pipefail`,
 * `+o opt`, `--norc`, `-s`, `--`), or when the body is piped into such a shell
 * (`cat <<EOF | sh`). An attached redirect (`<<EOF>/x`) does not change the
 * consumer. Any other command
 * (`RUN cat <<EOF > file`) gets data, which is not read; a skipped body that
 * contains an `npm install`, `npm i` or `npm ci` gives a warning instead of
 * passing silently. A marker without a
 * delimiter line consumes nothing and gives the warning
 * `unterminated heredoc <<WORD at line N` (N = the RUN start line).
 * RUN text is split on `&&`, `||`, `;`, `|` and newlines; leading shell
 * keywords (`then`, `else`, `elif`, `do`, `if`, `while`, `until`, `!`) and
 * subshell or group brackets are ignored. Each `FROM` starts a stage
 * (`AS name` names it).
 * Instructions are evaluated strictly in file order within a stage. A stage
 * `FROM <earlier stage>` also inherits that stage's copied manifests and
 * lockfile state (like image, npm major and the legacy-peer-deps ENV).
 *
 * (a) Lockfile-less install: a `RUN` contains the command `npm install` or
 *     `npm i` (also after `&&`, `;`, `||`, `|` or inside `sh -c "..."`) with
 *     NO non-flag arguments (a project install; `npm install .` counts) and
 *     no `-g`/`--global`. Value-taking options (`--omit`, `--include`,
 *     `--prefix`, `-C`, `--loglevel`, `--cache`, `--registry`, `--workspace`,
 *     `-w`) consume their next token, also before the subcommand
 *     (`npm --prefix /app install`). A bare `npm i -g npm` means latest.
 *     `npm install -g npm@11` and `npm install <pkg>` do not count; `npm ci`
 *     does not count. The lockfile counts as present when, earlier in the
 *     same stage, a `COPY`/`ADD` without `--from` copies package-lock.json or
 *     npm-shrinkwrap.json (explicitly or via a glob such as
 *     `package*.json`), or a directory copy such as `COPY . .` copies a
 *     context directory that contains the file. Explicit bypass (counts as
 *     lockfile-less even if the file is there): `--no-package-lock` on the
 *     install, or an earlier `rm` of package-lock.json (matched by file name)
 *     in the stage.
 *     `COPY --from=<stage>` is not followed.
 * (b) coverage-v8: a package.json copied into the stage before the install
 *     (source path relative to the context; `COPY . .` means
 *     <context>/package.json; a glob such as `package*.json` means
 *     <context>/package.json) lists `@vitest/coverage-v8` in dependencies,
 *     devDependencies or optionalDependencies. Unreadable or invalid JSON
 *     gives a warning, never a finding.
 * (c) Builder npm major below 11, derived from the stage image
 *     (NODE_NPM_MAJOR below): node:<major>[.minor.patch][-suffix], also
 *     docker.io/library/node. Node 14 -> npm 6, 16 -> 8, 18 -> 10,
 *     20 -> 10, 22 -> 10, 24 -> 11, 25 and higher -> 11. Everything else is
 *     "unknown": lts, latest, current, no tag, digest-only, a variable in
 *     the tag, non-node images, and Node majors missing from the table.
 *     `FROM <earlier stage>` inherits that stage's image and npm major. An
 *     earlier `npm install -g npm@<ref>` (or `npm i -g`) in the stage
 *     overrides: major >= 11 -> 11, major < 11 -> that major, `latest`,
 *     `next` or a range without a major -> unknown.
 *
 * Masking: `--legacy-peer-deps` on the install, or
 * `ENV npm_config_legacy_peer_deps=true` earlier in the stage, avoids the
 * crash. That is no finding, but a report entry with `masked: true` and
 * verdict `masked` (it does not count in the summary). A COPY'd `.npmrc` with
 * legacy-peer-deps is NOT detected (known limit below).
 *
 * Verdict per install with (a) and (b): npm major < 11 -> `confirmed`;
 * unknown -> `unknown-builder` (counts as a finding, never as a pass);
 * >= 11 -> nothing. Missing (a) or (b): nothing.
 *
 * Output: human readable by default, `--json` for the stable structure
 *   { repos: [ { repo, dockerfiles, findings: [ { dockerfile, stage, line,
 *     verdict, image, npmMajor, manifest, lockfile, masked, reason } ], warnings } ],
 *     summary: { findings } }
 * `lockfile` is true when a lockfile was copied into the stage (so true for a
 * bypass case); `reason` is a short text such as "lockfile-less install,
 * npm 10 < 11" or "lockfile bypassed: --no-package-lock, unknown builder", and
 * the human line carries it as well.
 * Exit codes: 0 = no findings, 1 = at least one finding, 2 = usage error
 * (no arguments, unknown option, directory missing or not readable).
 *
 * Known limits: a COPY'd .npmrc with legacy-peer-deps is not read, no
 * .dockerignore, no COPY --from hand-over of node_modules or lockfiles, no
 * workspaces, no ARG resolution, no docker-compose build args, no corepack.
 * COPY/ADD heredocs (`COPY <<EOF /path`) are not recognised: their body lines
 * are parsed as instructions. The Node-to-npm table is maintained by hand (Node
 * minors can differ; Node 22.x bundles npm 10.x to this day).
 */
import fs from "node:fs";
import path from "node:path";

export type Verdict = "confirmed" | "unknown-builder" | "masked";

export interface Finding {
  dockerfile: string;
  stage: string | number;
  line: number;
  verdict: Verdict;
  image: string;
  npmMajor: number | null;
  manifest: string;
  /** Whether a lockfile was copied into the stage (true when the install bypasses it). */
  lockfile: boolean;
  masked: boolean;
  /** Short human-readable reason, e.g. "lockfile-less install, npm 10 < 11". */
  reason: string;
}

export interface RepoReport {
  repo: string;
  dockerfiles: string[];
  findings: Finding[];
  warnings: string[];
}

export interface AnalyzeOptions {
  /** Dockerfile path as shown in findings (default "Dockerfile"). */
  dockerfile?: string;
  /** Directory manifest paths are reported relative to (default: contextDir). */
  repoDir?: string;
}

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * Node major -> bundled npm major. Hand-maintained; anything not listed (and
 * not >= 25) is "unknown".
 */
export const NODE_NPM_MAJOR: Record<number, number> = {
  14: 6,
  16: 8,
  18: 10,
  20: 10,
  22: 10,
  24: 11,
};
const NODE_NPM_MAJOR_FROM_25 = 11;
const FIXED_NPM_MAJOR = 11;

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];
const COVERAGE_PKG = "@vitest/coverage-v8";

const HELP = [
  "Usage: npx tsx scripts/check-docker-npm-coverage.ts [--json] <repoDir>...",
  "",
  "Flags Dockerfiles that run a lockfile-less `npm install` in a builder with",
  "npm < 11 while a copied package.json carries @vitest/coverage-v8 (npm 10",
  "edgesOut crash). Only the combination of all three ingredients is flagged.",
  "Unknown builders (node:lts, ARG tags, non-node images) count as findings.",
  "",
  "Exit codes: 0 no findings, 1 at least one finding, 2 usage error.",
  "",
  "Known limits: no .npmrc, no .dockerignore, no COPY --from hand-over of",
  "node_modules or lockfiles, no workspaces, no ARG resolution, no",
  "docker-compose build args, no corepack, no COPY/ADD heredocs, RUN heredoc",
  "bodies of non-shell commands are not read, the Node-to-npm table is",
  "maintained by hand.",
].join("\n");

// ---------------------------------------------------------------------------
// Dockerfile parsing
// ---------------------------------------------------------------------------

interface Instruction {
  line: number;
  keyword: string;
  args: string;
}

/**
 * A heredoc marker word: `<<WORD`, `<<-WORD`, `<<'WORD'` or `<<"WORD"`,
 * optionally followed by an attached redirect or pipe (`<<EOF>/x`,
 * `<<EOF>>/x`, `<<EOF|sh`). A here-string `<<<word` does not match.
 */
const HEREDOC_WORD = /^<<-?(["']?)([A-Za-z_][\w-]*)\1([<>|&;].*)?$/s;

/** Shells whose heredoc body is shell text (`RUN bash <<EOF`); other commands get data. */
const HEREDOC_SHELLS = new Set(["sh", "bash", "ash", "dash"]);

/**
 * Wrapper commands skipped before deciding whether the consumer of a heredoc
 * is a shell, with the options that take a separate value token.
 */
const HEREDOC_WRAPPERS: Record<string, Set<string>> = {
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
  sudo: new Set([
    "-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t",
    "--user", "--group", "--host", "--prompt", "--chdir", "--chroot", "--role", "--type",
  ]),
  command: new Set(),
  exec: new Set(["-a"]),
  nice: new Set(["-n", "--adjustment"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
};

const HEREDOC_LEADING_KEYWORDS = new Set(["then", "else", "elif", "do", "if", "while", "until", "!"]);

/** Drops wrapper commands (with their options), VAR=val prefixes and leading shell keywords. */
function skipHeredocWrappers(input: string[]): string[] {
  const tokens = input.map((t) => t.replace(/^[({]+/, "")).filter(Boolean);
  for (;;) {
    const t = tokens[0];
    if (t === undefined) return tokens;
    if (/^\w+=/.test(t) || HEREDOC_LEADING_KEYWORDS.has(t)) {
      tokens.shift();
      continue;
    }
    const valueFlags = HEREDOC_WRAPPERS[path.posix.basename(t)];
    if (valueFlags === undefined) return tokens;
    tokens.shift();
    while (tokens.length > 0 && (tokens[0].startsWith("-") || /^\w+=/.test(tokens[0]))) {
      const flag = tokens.shift() as string;
      if (flag === "--") break;
      if (valueFlags.has(flag)) tokens.shift();
    }
  }
}

/**
 * Whether the command words consume a heredoc body as shell text: a shell
 * (after wrappers and VAR=val prefixes) with only option flags (`-e`, `-x`,
 * `-o pipefail`, `+o`, `--norc`, `-s`, `--`).
 */
function isShellConsumer(words: string[]): boolean {
  const tokens = skipHeredocWrappers(words);
  if (tokens.length === 0 || !HEREDOC_SHELLS.has(path.posix.basename(tokens[0]))) return false;
  let seenS = false;
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (/^[-+][A-Za-z]*[oO]$/.test(t)) {
      // `-o`, `-eo`, `+o`, `-O`: the next token is the option name.
      k++;
      continue;
    }
    if (t === "--") return seenS;
    if (/^[-+][A-Za-z]+$/.test(t)) {
      if (t.includes("s")) seenS = true;
      continue;
    }
    if (/^--[a-z][a-z-]*$/.test(t)) continue;
    // A script file or script text: stdin is data, unless -s made the rest positional parameters.
    return seenS;
  }
  return true;
}

/** Whether a pipeline stage after the marker (`cat <<EOF | sh`) feeds the body into a shell. */
function pipesIntoShell(tail: string): boolean {
  const segment = tail.split(/&&|\|\||;/)[0];
  return segment
    .split("|")
    .slice(1)
    .some((stage) => isShellConsumer(stage.replace(/["']/g, " ").split(/\s+/).filter(Boolean)));
}

interface HeredocMark {
  start: number;
  end: number;
  delimiter: string;
  /** Whether the body is read as shell text (empty command, a shell before the marker, or a pipe into a shell). */
  shell: boolean;
}

/**
 * Heredoc markers in RUN text, BuildKit style: a whitespace-separated word
 * outside quotes that starts with `<<` (optionally after a file descriptor
 * number) and is exactly a heredoc marker. `x<<y`, `"x<<y"`, `$((a<<b))` and
 * a here-string `<<<word` are no markers.
 */
function heredocMarks(text: string): HeredocMark[] {
  const marks: HeredocMark[] = [];
  let quote: string | null = null;
  let wordStart = -1;
  const finish = (end: number): void => {
    if (wordStart < 0) return;
    const word = text.slice(wordStart, end).replace(/^\d+/, "");
    const start = wordStart;
    wordStart = -1;
    if (!word.startsWith("<<")) return;
    const m = HEREDOC_WORD.exec(word);
    if (!m) return;
    const before = text.slice(0, start).split(/&&|\|\||;|\||\r?\n/).pop() ?? "";
    // Leading RUN flags (`RUN --network=host <<EOF`) are no command words.
    const tokens = before.split(/\s+/).filter((t) => t && !/^--[a-z-]+(?:=\S+)?$/i.test(t));
    const tail = (m[3] ?? "") + (text.slice(end).split(/\r?\n/)[0] ?? "");
    const shell = tokens.length === 0 || isShellConsumer(tokens) || pipesIntoShell(tail);
    marks.push({ start, end, delimiter: m[2], shell });
  };
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote !== null) {
      if (c === "\\" && quote === '"') k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (/\s/.test(c)) {
      finish(k);
      continue;
    }
    if (wordStart < 0) wordStart = k;
    if (c === "\\") k++;
    else if (c === '"' || c === "'") quote = c;
  }
  finish(text.length);
  return marks;
}

/**
 * Splits a Dockerfile into instructions. Warnings (such as an unterminated
 * heredoc) are pushed onto `warnings` when given.
 */
export function parseInstructions(content: string, warnings: string[] = []): Instruction[] {
  const out: Instruction[] = [];
  const lines = content.split(/\r?\n/);
  let current: { line: number; text: string } | null = null;
  // Emits the finished instruction; for a RUN with heredocs the body lines up
  // to each delimiter belong to the RUN (not separate instructions), and a
  // shell body becomes part of the RUN text. A marker without a delimiter
  // line consumes nothing and gives a warning. Returns the last line consumed.
  const emit = (startLine: number, rawText: string, index: number): number => {
    const m = /^(\S+)\s*(.*)$/s.exec(rawText.trim());
    if (!m) return index;
    const keyword = m[1].toUpperCase();
    let args = m[2];
    let last = index;
    if (keyword === "RUN") {
      for (const h of heredocMarks(m[2])) {
        let end = last + 1;
        while (end < lines.length && lines[end].trim() !== h.delimiter) end++;
        if (end >= lines.length) {
          warnings.push(`unterminated heredoc <<${h.delimiter} at line ${startLine}`);
          continue;
        }
        const body = lines.slice(last + 1, end).join("\n");
        if (h.shell) args += "\n" + body;
        else if (/\bnpm\b[^\n]*\b(?:install|i|ci)\b/.test(body)) {
          warnings.push(
            `npm install/ci in heredoc body <<${h.delimiter} at line ${startLine} was not read (the command before the marker is not a recognised shell)`,
          );
        }
        last = end;
      }
    }
    out.push({ line: startLine, keyword, args });
    return last;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith("#")) continue; // comment (also inside a continuation)
    if (current === null) {
      if (trimmed === "") continue;
      current = { line: i + 1, text: "" };
    } else if (trimmed === "") {
      continue;
    }
    if (/\\\s*$/.test(raw)) {
      current.text += raw.replace(/\\\s*$/, "") + " ";
      continue;
    }
    current.text += raw;
    i = emit(current.line, current.text, i);
    current = null;
  }
  if (current !== null) emit(current.line, current.text, lines.length - 1);
  return out;
}

/** npm major for a FROM image, or null when unknown. */
export function npmMajorForImage(image: string): number | null {
  const m = /^(?:docker\.io\/)?(?:library\/)?node:(\d+)(?:[.@-][^\s]*)?$/.exec(image);
  if (!m) return null;
  if (image.includes("$")) return null;
  const node = Number(m[1]);
  if (node >= 25) return NODE_NPM_MAJOR_FROM_25;
  return NODE_NPM_MAJOR[node] ?? null;
}

function majorFromNpmRef(ref: string): number | null {
  const m = /^[\^~>=<v\s]*(\d+)/.exec(ref);
  if (!m) return null;
  return Number(m[1]);
}

function isGlob(s: string): boolean {
  return /[*?[]/.test(s);
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|\\]/g, "\\$&");
  return new RegExp("^" + esc.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
}

function copySources(args: string): { from: boolean; sources: string[] } {
  let rest = args.trim();
  let from = false;
  while (rest.startsWith("--")) {
    const m = /^(--\S+)\s*(.*)$/s.exec(rest);
    if (!m) break;
    if (m[1].toLowerCase().startsWith("--from")) from = true;
    rest = m[2];
  }
  let tokens: string[];
  if (rest.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(rest);
      tokens = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      tokens = rest.split(/\s+/).filter(Boolean);
    }
  } else {
    tokens = rest.split(/\s+/).filter(Boolean);
  }
  return { from, sources: tokens.length > 1 ? tokens.slice(0, -1) : tokens };
}

interface RunCommand {
  tokens: string[];
  envLegacy: boolean;
}

const WRAPPERS = new Set(["sh", "bash", "ash", "-c", "-lc", "-ec", "-e", "sudo", "exec", "time"]);
const SHELL_KEYWORDS = new Set(["then", "else", "elif", "do", "if", "while", "until", "!"]);

function splitRun(args: string): RunCommand[] {
  let text = args.trim();
  // Leading RUN flags such as --mount=..., --network=..., --security=...
  for (;;) {
    const f = /^--[a-z-]+(?:=\S+)?\s*/i.exec(text);
    if (!f) break;
    text = text.slice(f[0].length);
  }
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) text = parsed.map(String).join(" ");
    } catch {
      // keep the raw text
    }
  }
  for (const h of heredocMarks(text).reverse()) {
    text = text.slice(0, h.start) + " " + text.slice(h.end);
  }
  const parts = text.replace(/["']/g, " ").split(/&&|\|\||;|\||\r?\n/);
  const cmds: RunCommand[] = [];
  for (const part of parts) {
    const tokens = part
      .split(/\s+/)
      .map((t) => t.replace(/^[({]+/, "").replace(/[)};]+$/, ""))
      .filter(Boolean);
    let envLegacy = false;
    while (
      tokens.length > 0 &&
      (WRAPPERS.has(tokens[0]) || SHELL_KEYWORDS.has(tokens[0]) || /^\w+=/.test(tokens[0]))
    ) {
      const t = tokens.shift() as string;
      if (/^npm_config_legacy_peer_deps=true$/i.test(t)) envLegacy = true;
    }
    if (tokens.length > 0) cmds.push({ tokens, envLegacy });
  }
  return cmds;
}

/** npm options that consume the next token as their value. */
const NPM_VALUE_FLAGS = new Set([
  "--omit",
  "--include",
  "--prefix",
  "-C",
  "--loglevel",
  "--cache",
  "--registry",
  "--workspace",
  "-w",
]);

/** Splits the tokens after `npm` into subcommand, flags (before or after it) and positional args. */
function parseNpmArgs(tokens: string[]): { sub: string | null; flags: string[]; positional: string[] } {
  const flags: string[] = [];
  const positional: string[] = [];
  let sub: string | null = null;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.startsWith("-")) {
      flags.push(t);
      if (NPM_VALUE_FLAGS.has(t)) k++;
      continue;
    }
    if (sub === null) sub = t;
    else positional.push(t);
  }
  return { sub, flags, positional };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface StageState {
  index: number;
  name: string | null;
  image: string;
  npmMajor: number | null;
  legacyEnv: boolean;
  lockfileCopied: boolean;
  lockfileRemoved: boolean;
  manifests: string[];
}

function manifestHasCoverage(file: string): { has: boolean; warning?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { has: false, warning: `cannot read ${file}` };
  }
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const section = json[key];
      if (section && typeof section === "object" && COVERAGE_PKG in (section as object)) {
        return { has: true };
      }
    }
    return { has: false };
  } catch {
    return { has: false, warning: `invalid JSON in ${file}` };
  }
}

export function analyzeDockerfile(
  content: string,
  contextDir: string,
  opts: AnalyzeOptions = {},
): { findings: Finding[]; warnings: string[] } {
  const dockerfile = opts.dockerfile ?? "Dockerfile";
  const repoDir = opts.repoDir ?? contextDir;
  const findings: Finding[] = [];
  const warnings: string[] = [];
  const stages: StageState[] = [];
  let stage: StageState | null = null;

  const rel = (p: string) => path.relative(repoDir, p).split(path.sep).join("/");

  const parseWarnings: string[] = [];
  const instructions = parseInstructions(content, parseWarnings);
  for (const w of parseWarnings) warnings.push(`${dockerfile}: ${w}`);
  for (const ins of instructions) {
    if (ins.keyword === "FROM") {
      const tokens = ins.args.split(/\s+/).filter((t) => t && !t.startsWith("--"));
      const baseRef = tokens[0] ?? "";
      let name: string | null = null;
      if (tokens[1] && tokens[1].toLowerCase() === "as" && tokens[2]) name = tokens[2];
      const parent = stages.find((s) => s.name !== null && s.name.toLowerCase() === baseRef.toLowerCase());
      stage = {
        index: stages.length + 1,
        name,
        image: parent ? parent.image : baseRef,
        npmMajor: parent ? parent.npmMajor : npmMajorForImage(baseRef),
        legacyEnv: parent ? parent.legacyEnv : false,
        lockfileCopied: parent ? parent.lockfileCopied : false,
        lockfileRemoved: parent ? parent.lockfileRemoved : false,
        manifests: parent ? [...parent.manifests] : [],
      };
      stages.push(stage);
      continue;
    }
    if (stage === null) continue;

    if (ins.keyword === "ENV") {
      if (/npm_config_legacy_peer_deps(?:=|\s+)"?true"?/i.test(ins.args)) stage.legacyEnv = true;
      continue;
    }

    if (ins.keyword === "COPY" || ins.keyword === "ADD") {
      const { from, sources } = copySources(ins.args);
      if (from) continue;
      for (const src of sources) {
        const abs = path.resolve(contextDir, src);
        let isDir = false;
        try {
          isDir = fs.statSync(abs).isDirectory();
        } catch {
          isDir = false;
        }
        const dir = isDir ? abs : path.dirname(abs);
        const base = isDir ? null : path.basename(abs);
        const matches = (name: string): boolean => {
          if (base === null) return fs.existsSync(path.join(dir, name));
          if (isGlob(base)) return globToRegExp(base).test(name) && fs.existsSync(path.join(dir, name));
          return base === name;
        };
        if (matches("package.json")) {
          const m = path.join(dir, "package.json");
          if (!stage.manifests.includes(m)) stage.manifests.push(m);
        }
        if (LOCKFILES.some(matches)) stage.lockfileCopied = true;
      }
      continue;
    }

    if (ins.keyword !== "RUN") continue;

    for (const cmd of splitRun(ins.args)) {
      const [bin, ...after] = cmd.tokens;
      if (bin === "rm" && after.some((t) => LOCKFILES.includes(path.posix.basename(t)))) {
        stage.lockfileRemoved = true;
        continue;
      }
      if (bin !== "npm") continue;
      const { sub, flags, positional: rawPositional } = parseNpmArgs(after);
      if (sub !== "install" && sub !== "i") continue;
      // `npm install .` installs the project in the current directory.
      const positional = rawPositional.filter((p) => p !== "." && p !== "./");
      const global = flags.includes("-g") || flags.includes("--global");
      if (global) {
        // A bare `npm i -g npm` means the latest npm: unknown.
        const ref = positional.find((p) => p === "npm" || p.startsWith("npm@"));
        if (ref !== undefined) stage.npmMajor = ref === "npm" ? null : majorFromNpmRef(ref.slice(4));
        continue;
      }
      if (positional.length > 0) continue; // `npm install <pkg>`: not a project install

      // Ingredient (a): lockfile-less project install.
      const bypassKind = flags.includes("--no-package-lock")
        ? "--no-package-lock"
        : stage.lockfileRemoved
          ? "rm package-lock.json"
          : null;
      if (stage.lockfileCopied && bypassKind === null) continue;
      const bypassed = stage.lockfileCopied;

      // Ingredient (b): coverage-v8 in a copied manifest.
      let manifest: string | null = null;
      for (const m of stage.manifests) {
        const r = manifestHasCoverage(m);
        if (r.warning) {
          const w = `${dockerfile}: ${r.warning.replace(m, rel(m))}`;
          if (!warnings.includes(w)) warnings.push(w);
        }
        if (r.has && manifest === null) manifest = m;
      }
      if (manifest === null) continue;

      // Ingredient (c): builder npm below 11 (or unknown).
      const major = stage.npmMajor;
      if (major !== null && major >= FIXED_NPM_MAJOR) continue;
      const masked =
        flags.includes("--legacy-peer-deps") || flags.includes("--legacy-peer-deps=true") || stage.legacyEnv || cmd.envLegacy;
      const lockPart = bypassed ? `lockfile bypassed: ${bypassKind}` : "lockfile-less install";
      const builderPart = major === null ? "unknown builder" : `npm ${major} < ${FIXED_NPM_MAJOR}`;
      findings.push({
        dockerfile,
        stage: stage.name ?? stage.index,
        line: ins.line,
        verdict: masked ? "masked" : major === null ? "unknown-builder" : "confirmed",
        image: stage.image,
        npmMajor: major,
        manifest: rel(manifest),
        lockfile: bypassed,
        masked,
        reason: `${lockPart}, ${builderPart}`,
      });
    }
  }
  return { findings, warnings };
}

// ---------------------------------------------------------------------------
// Repo scan, formatting, CLI
// ---------------------------------------------------------------------------

function isDockerfileName(name: string): boolean {
  return name === "Dockerfile" || name.startsWith("Dockerfile.") || name.endsWith(".Dockerfile");
}

function findDockerfiles(dir: string, base: string, out: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".worktrees") continue;
      findDockerfiles(path.join(dir, e.name), base, out);
    } else if (e.isFile() && isDockerfileName(e.name)) {
      out.push(path.relative(base, path.join(dir, e.name)).split(path.sep).join("/"));
    }
  }
}

export function scanRepo(repoDir: string): RepoReport {
  const dockerfiles: string[] = [];
  findDockerfiles(repoDir, repoDir, dockerfiles);
  const report: RepoReport = { repo: repoDir, dockerfiles, findings: [], warnings: [] };
  for (const rel of dockerfiles) {
    const file = path.join(repoDir, rel);
    const content = fs.readFileSync(file, "utf8");
    const r = analyzeDockerfile(content, path.dirname(file), { dockerfile: rel, repoDir });
    report.findings.push(...r.findings);
    report.warnings.push(...r.warnings);
  }
  return report;
}

function countFindings(reports: RepoReport[]): number {
  let n = 0;
  for (const r of reports) for (const f of r.findings) if (!f.masked) n++;
  return n;
}

export function formatHuman(reports: RepoReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    for (const f of r.findings) {
      const npm = f.npmMajor === null ? "unknown" : String(f.npmMajor);
      lines.push(
        `${r.repo}/${f.dockerfile}:${f.line} [${f.verdict}] stage ${f.stage}, image ${f.image}, npm ${npm}, manifest ${f.manifest}, ${f.reason}` +
          (f.masked ? " (masked by --legacy-peer-deps, not counted)" : ""),
      );
    }
    for (const w of r.warnings) lines.push(`warning: ${r.repo}: ${w}`);
  }
  lines.push(`${countFindings(reports)} finding(s)`);
  return lines.join("\n");
}

export function run(argv: string[], io: Io): number {
  let json = false;
  const dirs: string[] = [];
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      io.stdout(HELP);
      return 0;
    }
    if (arg === "--json") json = true;
    else if (arg.startsWith("-")) {
      io.stderr(`Unknown option: ${arg}`);
      io.stderr(HELP);
      return 2;
    } else dirs.push(arg);
  }
  if (dirs.length === 0) {
    io.stderr(HELP);
    return 2;
  }
  const reports: RepoReport[] = [];
  for (const dir of dirs) {
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
      reports.push(scanRepo(dir));
    } catch {
      io.stderr(`Cannot read directory: ${dir}`);
      return 2;
    }
  }
  const findings = countFindings(reports);
  if (json) io.stdout(JSON.stringify({ repos: reports, summary: { findings } }, null, 2));
  else io.stdout(formatHuman(reports));
  return findings > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s + "\n"),
    stderr: (s) => process.stderr.write(s + "\n"),
  });
}
