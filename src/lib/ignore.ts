/**
 * .sotaignore / .gitignore for directory and git deploys, with the CLI's
 * pattern rules (cli/internal/archive/archive.go loadIgnorePatterns + shouldIgnore). Blank lines and # comments are skipped.
 * A pattern matches a relative path when
 *   - it ends in "/" and names that directory or a path below it,
 *   - it equals the path or its base name,
 *   - it contains "*" and glob-matches the base name or the whole path
 *     ("*" and "?" do not cross "/"), or
 *   - it equals one path component.
 * Additions to the CLI rules: a leading "/" anchors the pattern to the root
 * (as in git); "!" lines are skipped (no re-include); a pattern that is not a
 * valid glob is skipped (like Go's filepath.Match returning an error).
 *
 * Which file is read:
 *   - directory deploy: .sotaignore when it exists (an empty one means
 *     "nothing extra", it does NOT fall back to .gitignore); otherwise the
 *     .gitignore, but .env.production and .env.example are kept even when
 *     the .gitignore lists them (create-next-app's .gitignore has ".env*",
 *     and public build-time values such as NEXT_PUBLIC_* live there).
 *   - git_url deploy: only .sotaignore. A clone holds tracked files only,
 *     and tracked files that match the .gitignore (committed build output)
 *     have always been deployed.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface IgnoreRules {
  /** ".sotaignore", ".gitignore" or null when no file was used. */
  source: string | null;
  patterns: string[];
}

export const NO_RULES: IgnoreRules = { source: null, patterns: [] };

/** Kept when only the .gitignore fallback applies (base names). */
export const KEPT_FROM_GITIGNORE: ReadonlySet<string> = new Set(['.env.production', '.env.example']);

function readPatterns(path: string): string[] | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'));
  } catch {
    return null;
  }
}

export function loadIgnoreRules(root: string, opts: { gitignoreFallback: boolean }): IgnoreRules {
  const sota = readPatterns(join(root, '.sotaignore'));
  if (sota !== null) return { source: '.sotaignore', patterns: sota };
  if (opts.gitignoreFallback) {
    const git = readPatterns(join(root, '.gitignore'));
    if (git !== null) return { source: '.gitignore', patterns: git };
  }
  return NO_RULES;
}

/** null when the pattern is not a valid glob. */
function globToRegExp(glob: string): RegExp | null {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) return null; // unterminated class: invalid, like filepath.Match
      let cls = glob.slice(i + 1, end);
      if (cls.startsWith('!') || cls.startsWith('^')) cls = `^${cls.slice(1)}`;
      re += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return null;
  }
}

/** relPath uses "/" and has no leading "./". */
export function isIgnored(relPath: string, isDir: boolean, patterns: readonly string[]): boolean {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const parts = relPath.split('/');
  for (const raw of patterns) {
    const anchored = raw.startsWith('/');
    const pattern = anchored ? raw.slice(1) : raw;
    if (pattern === '') continue;
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      if (isDir && (relPath === dir || relPath.startsWith(`${dir}/`))) return true;
      if (!isDir && relPath.startsWith(`${dir}/`)) return true;
      continue;
    }
    if (relPath === pattern) return true;
    const wild = pattern.includes('*') || pattern.includes('?') || pattern.includes('[');
    const re = wild ? globToRegExp(pattern) : null;
    if (anchored) {
      if (re && re.test(relPath)) return true;
      continue;
    }
    if (base === pattern) return true;
    if (re && (re.test(base) || re.test(relPath))) return true;
    if (parts.includes(pattern)) return true;
  }
  return false;
}

/** isIgnored with the .gitignore-fallback exceptions. */
export function ignoredBy(rules: IgnoreRules, relPath: string, isDir: boolean): boolean {
  if (rules.patterns.length === 0) return false;
  if (!isIgnored(relPath, isDir, rules.patterns)) return false;
  if (rules.source === '.gitignore' && !isDir) {
    const base = relPath.slice(relPath.lastIndexOf('/') + 1);
    if (KEPT_FROM_GITIGNORE.has(base)) return false;
  }
  return true;
}
