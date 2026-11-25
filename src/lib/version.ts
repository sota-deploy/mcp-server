/**
 * The package version, read from package.json at runtime.
 *
 * Both entry points (stdio `index.ts` and hosted `http.ts`) report this
 * version, so /health and the MCP `initialize` handshake always match the
 * code that is actually running. The compiled file lives at
 * dist/lib/version.js, so ../../package.json is the package root in the
 * npm tarball, in a local checkout and in the Docker image (/app).
 */

import { readFileSync } from 'node:fs';

export function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version;
  } catch {
    // fall through: a missing package.json is a packaging bug, not a crash
  }
  return '0.0.0-unknown';
}

export const PACKAGE_VERSION = readPackageVersion();

/**
 * Commit and build time of the hosted image. The Dockerfile turns
 * the GIT_SHA and BUILD_TIME build args into environment variables of the
 * runtime stage. Anything built without them (npm package, local checkout,
 * a plain `docker compose build`) reports "unknown".
 */
export const UNKNOWN_BUILD = 'unknown';

export function readBuildValue(name: 'GIT_SHA' | 'BUILD_TIME', env: NodeJS.ProcessEnv = process.env): string {
  const value = (env[name] ?? '').trim();
  return value === '' ? UNKNOWN_BUILD : value;
}

export const GIT_SHA = readBuildValue('GIT_SHA');
export const BUILD_TIME = readBuildValue('BUILD_TIME');
