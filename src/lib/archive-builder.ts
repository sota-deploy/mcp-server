/**
 * Archive Builder — turn AI-supplied source into a tar.gz ready for upload.
 *
 * Three input modes for the `deploy` MCP tool:
 *   1. directory: string                     — existing CLI/Claude-Code flow
 *   2. files: Record<string,string>          — inline source from AI agent
 *   3. git_url: string + git_branch?: string — clone a public repo
 *
 * All three produce a tar.gz Buffer that the SDK uploads to
 * `POST /v1/projects/:id/deploy` via multipart/form-data. The backend
 * accepts the multipart upload identically regardless of source.
 *
 * Limits (deliberately generous — we want to lean permissive at launch):
 *   files:    MAX_INLINE_FILES entries, MAX_INLINE_TOTAL_BYTES total
 *   git_url:  MAX_CLONE_BYTES of archived files after `git clone --depth=1`
 *
 * The hosted server (mcp.sota.io) only uses `files`; directory and git_url
 * are local (stdio) modes, see tools/deploy.ts and lib/hosted-guard.ts.
 *
 * Security:
 *   - .git, node_modules, .DS_Store and the local/secret env files (.env,
 *     .env.local, .env.*.local, .envrc; any depth, any case) are left out
 *     of every archive, whatever the mode.
 *   - directory deploys honour the root .sotaignore (or, without one, the
 *     .gitignore, keeping .env.production and .env.example); git_url
 *     deploys honour only a .sotaignore (lib/ignore.ts).
 *   - git and tar run via execFile (no shell).
 *   - Inline file paths are normalised + rejected if they contain ".." or
 *     start with "/" or contain NUL.
 *   - Symlinks are not honoured for inline files (we only write regular files).
 *   - Git clone uses `--depth=1` and `--single-branch` to bound bandwidth.
 *   - Both modes write to a fresh /tmp dir which is removed after tar.gz is read.
 */

import { execFileSync } from 'child_process';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { type IgnoreRules, NO_RULES, ignoredBy, loadIgnoreRules } from './ignore.js';
import { dirname, join, resolve, sep } from 'path';

/**
 * Names excluded from every archive, at any directory depth, in any case:
 * the local/secret env files `.env`, `.env.local`, `.env.<anything>.local`
 * and direnv's `.envrc`. Committed variants such as `.env.production`,
 * `.env.development`, `.env.test` and `.env.example` are KEPT: sota builds
 * (railpack, docker build) never see set-env values, so apps rely on them
 * for build-time values like NEXT_PUBLIC_*.
 */
const LOCAL_ENV_FILE = /^\.env(?:(?:\.[^/]+)?\.local|rc)?$/i;

const ALWAYS_EXCLUDED = new Set(['.git', 'node_modules', '.DS_Store', '.sota.json', '__pycache__', '.venv']);

export function isExcludedName(name: string): boolean {
  // Same always-excluded names as the CLI (cli/internal/archive defaultIgnores)
  // where that is safe; the CLI's vendor/ and .env.* are deliberately not
  // copied: vendored dependencies are needed for the build, and committed
  // .env.production / .env.example carry public build-time values.
  if (ALWAYS_EXCLUDED.has(name)) return true;
  if (name.toLowerCase().endsWith('.log')) return true;
  return LOCAL_ENV_FILE.test(name);
}

/** Upper bound on inline file count (per single `deploy` call). */
export const MAX_INLINE_FILES = 200;
/** Upper bound on combined inline content length, in bytes. */
export const MAX_INLINE_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB
/** Upper bound on a cloned git repo, in bytes: the summed size of the files the tree walk would archive (collectEntries), so excluded paths such as .git do not count. */
export const MAX_CLONE_BYTES = 200 * 1024 * 1024; // 200 MB
/** Upper bound on path component count, to defeat absurd nesting attacks. */
const MAX_PATH_DEPTH = 32;

export class ArchiveBuilderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ArchiveBuilderError';
  }
}

/**
 * One inline file: a plain string is UTF-8 text; the object form can carry
 * binary content (images, fonts) as base64.
 */
export type InlineFile = string | { content: string; encoding?: 'utf8' | 'base64' };

const BASE64_INVALID = /[^A-Za-z0-9+/=\s]/;
const BASE64_PAD_MISPLACED = /=[\s]*[^=\s]/;

/**
 * Checks one inline file and returns its decoded size without decoding it.
 * base64 must be standard base64 (RFC 4648 section 4, padding optional,
 * whitespace and line breaks ignored); anything else is rejected with the
 * path in the message, so a truncated or URL-safe string never ships as a
 * corrupt asset. No copy of the content is made.
 */
export function inlineFileSize(path: string, file: InlineFile): number {
  if (typeof file === 'string') return Buffer.byteLength(file, 'utf8');
  if (!file || typeof file !== 'object' || typeof file.content !== 'string') {
    throw new ArchiveBuilderError('bad_file', `files["${path}"] must be a string or { content, encoding }`);
  }
  const encoding = file.encoding ?? 'utf8';
  if (encoding === 'utf8') return Buffer.byteLength(file.content, 'utf8');
  if (encoding !== 'base64') {
    throw new ArchiveBuilderError('bad_encoding', `files["${path}"].encoding must be "utf8" or "base64"`);
  }
  const s = file.content;
  const invalid = () =>
    new ArchiveBuilderError(
      'invalid_base64',
      `files["${path}"] is not valid base64 (standard alphabet A-Z a-z 0-9 + /, optional = padding, nothing cut off); re-encode the file and try again`,
    );
  if (BASE64_INVALID.test(s) || BASE64_PAD_MISPLACED.test(s)) throw invalid();
  // Count significant characters and padding in one pass (no copy).
  let chars = 0;
  let pad = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0b || c === 0x0c) continue;
    if (c === 0x3d) pad++;
    else chars++;
  }
  if (pad > 2) throw invalid();
  if (pad > 0 && (chars + pad) % 4 !== 0) throw invalid();
  const rem = chars % 4;
  if (rem === 1) throw invalid();
  return Math.floor(chars / 4) * 3 + (rem === 0 ? 0 : rem - 1);
}

/** Decode one inline file to its bytes (validated by inlineFileSize first). */
export function decodeInlineFile(path: string, file: InlineFile): Buffer {
  const expected = inlineFileSize(path, file);
  if (typeof file === 'string') return Buffer.from(file, 'utf8');
  if ((file.encoding ?? 'utf8') === 'utf8') return Buffer.from(file.content, 'utf8');
  // Node's decoder skips whitespace itself; the length check proves that
  // every character was decoded.
  const buf = Buffer.from(file.content, 'base64');
  if (buf.length !== expected) {
    throw new ArchiveBuilderError('invalid_base64', `files["${path}"] is not valid base64 (it does not decode cleanly); re-encode the file and try again`);
  }
  return buf;
}

/**
 * Pack a record of file paths → content into a tar.gz Buffer.
 *
 * A string value is UTF-8 text; `{ content, encoding: "base64" }` carries
 * binary content. The size limit counts decoded bytes and is checked for
 * all files before anything is decoded; files are then decoded and written
 * one at a time, so at most one decoded file is held in memory. Two paths
 * that name the same file (`a`, `./a`, `/a`) are refused. The caller is
 * responsible for including framework manifests (package.json,
 * requirements.txt, or a Dockerfile) so the backend's auto-detection picks
 * the right builder.
 */
export function archiveFromFiles(files: Record<string, InlineFile>): Buffer {
  const entries = Object.entries(files);
  if (entries.length === 0) {
    throw new ArchiveBuilderError('empty_files', 'files map cannot be empty');
  }
  if (entries.length > MAX_INLINE_FILES) {
    throw new ArchiveBuilderError(
      'too_many_files',
      `files map has ${entries.length} entries (max ${MAX_INLINE_FILES})`,
    );
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  const planned: Array<[string, string, InlineFile]> = [];
  for (const [rawPath, content] of entries) {
    const safePath = sanitiseInlinePath(rawPath);
    if (seen.has(safePath)) {
      throw new ArchiveBuilderError('bad_path', `two entries name the same file: ${safePath}`);
    }
    seen.add(safePath);
    totalBytes += inlineFileSize(rawPath, content);
    if (totalBytes > MAX_INLINE_TOTAL_BYTES) {
      throw new ArchiveBuilderError(
        'inline_too_large',
        `combined content exceeds ${MAX_INLINE_TOTAL_BYTES} bytes (decoded)`,
      );
    }
    planned.push([rawPath, safePath, content]);
  }

  const workdir = mkdtempSync(join(tmpdir(), 'sota-inline-'));
  try {
    for (const [rawPath, safePath, content] of planned) {
      const abs = join(workdir, safePath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, decodeInlineFile(rawPath, content));
    }
    return tarGzWorkdir(workdir);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * `git clone --depth=1` the given URL (optionally on a specified branch),
 * then pack the resulting workdir into a tar.gz Buffer. Only public repos
 * are supported in v1 — there is no credential plumbing.
 *
 * Rejects URLs that don't begin with https://, http://, git://, ssh://, or
 * the scp-like git@host:path form, to keep the surface predictable.
 */
export function archiveFromGitUrl(gitUrl: string, gitBranch?: string): Buffer {
  const url = gitUrl.trim();
  if (!isPlausibleGitURL(url)) {
    throw new ArchiveBuilderError(
      'bad_git_url',
      `git_url must look like a URL (https://, git://, ssh://, or git@host:path) — got: ${url.slice(0, 80)}`,
    );
  }
  if (url.length > 2000) {
    throw new ArchiveBuilderError('bad_git_url', 'git_url too long (max 2000 chars)');
  }
  const branch = gitBranch ? gitBranch.trim() : '';
  if (branch && !/^[\w./\-]{1,255}$/.test(branch)) {
    throw new ArchiveBuilderError(
      'bad_git_branch',
      'git_branch contains invalid characters or exceeds 255 chars',
    );
  }

  const workdir = mkdtempSync(join(tmpdir(), 'sota-git-'));
  try {
    // Cap clone bandwidth/time. `--depth=1` cuts history to the tip commit.
    // `--single-branch` avoids fetching all refs.
    const args = ['clone', '--depth=1', '--single-branch'];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push('--', url, workdir);
    try {
      execFileSync('git', args, {
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ArchiveBuilderError(
        'git_clone_failed',
        `git clone failed (URL=${url.slice(0, 120)}${branch ? `, branch=${branch}` : ''}): ${detail.slice(0, 300)}`,
      );
    }

    // Hard size cap: refuse repos that ballooned past MAX_CLONE_BYTES.
    // A clone holds only tracked files: .gitignore must not drop tracked
    // ones (e.g. committed build output), so only a .sotaignore applies.
    const rules = loadIgnoreRules(workdir, { gitignoreFallback: false });
    const sizeBytes = collectEntries(workdir, rules).totalBytes;
    if (sizeBytes > MAX_CLONE_BYTES) {
      throw new ArchiveBuilderError(
        'clone_too_large',
        `cloned repo is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB (max ${(MAX_CLONE_BYTES / 1024 / 1024).toFixed(0)} MB)`,
      );
    }

    return tarGzWorkdir(workdir, rules);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * Pack an existing local directory into a tar.gz Buffer using the same
 * ignore rules as every other mode (see isExcludedName: .git, node_modules,
 * .DS_Store and the local/secret .env files). Exported so the deploy tool can re-use a
 * single code path for archive construction.
 */
export function archiveFromDirectory(dir: string): Buffer {
  return archiveDirectoryWithReport(dir).archive;
}

/** What a directory deploy packed (for the tool result). */
export interface DirectoryArchive {
  archive: Buffer;
  /** Number of regular files in the archive. */
  files: number;
  /** ".sotaignore", ".gitignore" or null when neither was found. */
  ignoreFile: string | null;
}

export function archiveDirectoryWithReport(dir: string): DirectoryArchive {
  const abs = resolve(dir);
  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    throw new ArchiveBuilderError('not_found', `Directory not found: ${abs}`);
  }
  if (!isDir) {
    throw new ArchiveBuilderError('not_a_directory', `Not a directory: ${abs}`);
  }
  const rules = loadIgnoreRules(abs, { gitignoreFallback: true });
  const { files } = collectEntries(abs, rules);
  return { archive: tarGzWorkdir(abs, rules), files, ignoreFile: rules.source };
}

/**
 * Walk `root` and return the archive entries ("./rel/path", parents before
 * children) plus the byte size of the regular files. Excluded names are
 * skipped at every depth, and excluded directories are not descended into.
 * Symlinks are archived as links and never followed.
 */
export function collectEntries(
  root: string,
  rules: IgnoreRules = NO_RULES,
): { entries: string[]; totalBytes: number; files: number } {
  const entries: string[] = [];
  let totalBytes = 0;
  let files = 0;
  const walk = (absDir: string, relDir: string) => {
    const dirents = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const d of dirents) {
      if (isExcludedName(d.name)) continue;
      const abs = join(absDir, d.name);
      const rel = `${relDir}/${d.name}`;
      if (ignoredBy(rules, rel.slice(2), d.isDirectory())) continue;
      entries.push(rel);
      if (d.isDirectory()) {
        walk(abs, rel);
      } else if (d.isFile()) {
        totalBytes += lstatSync(abs).size;
        files++;
      }
    }
  };
  walk(root, '.');
  return { entries, totalBytes, files };
}

function tarGzWorkdir(workdir: string, rules: IgnoreRules = NO_RULES): Buffer {
  const { entries } = collectEntries(workdir, rules);
  // The explicit NUL-separated file list (instead of tar --exclude patterns)
  // makes the exclusions identical on GNU tar and bsdtar (macOS, Windows)
  // and case-insensitive for the .env names.
  const scratch = mkdtempSync(join(tmpdir(), 'sota-deploy-'));
  const archivePath = join(scratch, 'source.tar.gz');
  const listPath = join(scratch, 'files.list');
  try {
    writeFileSync(listPath, entries.map((e) => `${e}\0`).join(''));
    try {
      execFileSync(
        'tar',
        ['-czf', archivePath, '-C', workdir, '--no-recursion', '--null', '-T', listPath],
        { stdio: 'pipe' },
      );
    } catch (err) {
      if (!isUnknownNullOption(err)) throw tarFailed(err);
      // BusyBox tar (Alpine) has no --null. It reads the list line by line
      // and takes every line literally, so a newline-separated list is the
      // same thing as long as no name contains a newline.
      if (entries.some((e) => e.includes('\n'))) {
        throw new ArchiveBuilderError(
          'tar_failed',
          'a file name contains a line break, and the tar on this system (BusyBox) cannot pack such names; rename the file or install GNU tar',
        );
      }
      rmSync(archivePath, { force: true });
      writeFileSync(listPath, entries.map((e) => `${e}\n`).join(''));
      try {
        execFileSync(
          'tar',
          ['-czf', archivePath, '-C', workdir, '--no-recursion', '-T', listPath],
          { stdio: 'pipe' },
        );
      } catch (err2) {
        throw tarFailed(err2);
      }
    }
    return readFileSync(archivePath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function tarStderr(err: unknown): string {
  const raw = (err as { stderr?: Buffer | string } | null)?.stderr;
  return raw ? raw.toString() : err instanceof Error ? err.message : String(err);
}

/** True when tar refused to start because it does not know `--null`. */
export function isUnknownNullOption(err: unknown): boolean {
  const text = tarStderr(err);
  return /(unrecognized|unknown|invalid|illegal) option/i.test(text) && /null/i.test(text);
}

function tarFailed(err: unknown): ArchiveBuilderError {
  return new ArchiveBuilderError(
    'tar_failed',
    `could not pack the source archive: ${tarStderr(err).trim().slice(0, 300)}`,
  );
}

function sanitiseInlinePath(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new ArchiveBuilderError('bad_path', 'file path must be a non-empty string');
  }
  if (raw.includes('\0')) {
    throw new ArchiveBuilderError('bad_path', 'file path contains NUL byte');
  }
  if (raw.length > 1024) {
    throw new ArchiveBuilderError('bad_path', `file path too long (max 1024 chars): ${raw.slice(0, 80)}…`);
  }
  // Strip leading "./" and "/"; reject ".." segments.
  let p = raw.replace(/^\.?\//, '').replace(/\\/g, '/');
  if (p.startsWith('/')) {
    p = p.slice(1);
  }
  if (p === '' || p === '.' || p === '..') {
    throw new ArchiveBuilderError('bad_path', `invalid file path: ${raw}`);
  }
  const segments = p.split('/');
  if (segments.length > MAX_PATH_DEPTH) {
    throw new ArchiveBuilderError(
      'bad_path',
      `path too deep (${segments.length} segments, max ${MAX_PATH_DEPTH}): ${raw}`,
    );
  }
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ArchiveBuilderError('bad_path', `invalid path segment in: ${raw}`);
    }
  }
  return segments.join(sep);
}

function isPlausibleGitURL(s: string): boolean {
  if (s.startsWith('https://') || s.startsWith('http://')) return true;
  if (s.startsWith('git://')) return true;
  if (s.startsWith('ssh://')) return true;
  if (s.startsWith('git@') && s.includes(':')) return true;
  return false;
}
