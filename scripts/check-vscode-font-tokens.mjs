#!/usr/bin/env node

import * as fs from 'node:fs';

const DEFAULT_VSCODE_REF = 'stable';
const STABLE_RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable';
const REQUESTED_VSCODE_REF = process.argv[2] ?? process.env.VSCODE_SOURCE_REF ?? DEFAULT_VSCODE_REF;
const EXPECTATIONS_BY_FILE = {
  'src/vs/workbench/browser/media/style.css': {
    windows: ['"Segoe WPC"', '"Segoe UI"'],
    macos: ['-apple-system', 'BlinkMacSystemFont'],
    linux: ['system-ui', '"Ubuntu"', '"Droid Sans"'],
  },
  'src/vs/editor/standalone/browser/standalone-tokens.css': {
    windows: ['"Segoe WPC"', '"Segoe UI"'],
    macos: ['-apple-system', 'BlinkMacSystemFont'],
    linux: ['system-ui', '"Ubuntu"', '"Droid Sans"'],
  },
};

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const BASE_RAW_URL = 'https://raw.githubusercontent.com/microsoft/vscode';

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined;
}

function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

async function fetchStableVersion() {
  const response = await fetch(STABLE_RELEASES_URL, {
    headers: {
      'User-Agent': 'font-changer-ci-guard',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve the latest stable version (${response.status} ${response.statusText})`);
  }

  const releases = await response.json();
  const latest = Array.isArray(releases) ? releases.find(version => typeof version === 'string') : undefined;
  if (!latest) {
    throw new Error('The latest stable release feed did not contain a version.');
  }

  return latest;
}

async function resolveRequestedRef() {
  if (REQUESTED_VSCODE_REF === 'stable' || REQUESTED_VSCODE_REF === 'latest') {
    try {
      return await fetchStableVersion();
    } catch (error) {
      const fallback = packageJson.engines?.vscode?.replace(/^[^\d]*/, '');
      if (!fallback) {
        throw error;
      }

      console.warn(`[guard] WARNING: ${error instanceof Error ? error.message : String(error)}`);
      console.warn(`[guard] Falling back to the minimum supported version: ${fallback}`);
      return fallback;
    }
  }

  return REQUESTED_VSCODE_REF;
}

function getCandidateRefs(ref) {
  const version = parseVersion(ref);
  if (!version) {
    return [ref];
  }

  // VS Code tags can lag the stable release feed by a few days. The release
  // branch is cut at the same time as the release, so it is a safe fallback.
  return [ref, `release/${version.major}.${version.minor}`];
}

async function fetchFile(path, ref) {
  const response = await fetch(`${BASE_RAW_URL}/${encodeURIComponent(ref)}/${path}`, {
    headers: {
      'User-Agent': 'font-changer-ci-guard',
      Accept: 'text/plain',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${path} at ${ref} (${response.status} ${response.statusText})`);
  }

  return response.text();
}

async function fetchFileFromFirstAvailableRef(path, refs) {
  const failures = [];

  for (const ref of refs) {
    try {
      return { ref, content: await fetchFile(path, ref) };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(failures.join(' | '));
}

async function main() {
  const resolvedRef = await resolveRequestedRef();
  const candidateRefs = getCandidateRefs(resolvedRef);
  let failed = false;
  let usedRef = resolvedRef;

  console.log(`[guard] VS Code source ref: ${resolvedRef}`);

  const resolvedVersion = parseVersion(resolvedRef);
  const engineVersion = parseVersion(packageJson.engines?.vscode);
  if (resolvedVersion && engineVersion) {
    const comparison = compareVersions(engineVersion, resolvedVersion);
    if (comparison > 0) {
      console.error(
        `[guard] ERROR: engines.vscode (${packageJson.engines.vscode}) is newer than the checked VS Code release (${resolvedRef}).`,
      );
      failed = true;
    } else if (comparison < 0) {
      console.warn(
        `[guard] WARNING: engines.vscode (${packageJson.engines.vscode}) is older than the latest stable release (${resolvedRef}).`,
      );
      console.warn('[guard] Bump engines.vscode and @types/vscode to keep this extension on the latest release.');
    }
  }

  for (const [path, expectations] of Object.entries(EXPECTATIONS_BY_FILE)) {
    const { ref, content } = await fetchFileFromFirstAvailableRef(path, candidateRefs);
    usedRef = ref;

    for (const [platform, tokens] of Object.entries(expectations)) {
      const missing = tokens.filter(token => !content.includes(token));
      if (missing.length > 0) {
        console.error(`[guard] ERROR: ${path} (${platform}) is missing: ${missing.join(', ')}`);
        failed = true;
      } else {
        console.log(`[guard] PASS: ${path} (${platform}) contains all ${tokens.length} tokens`);
      }
    }
  }

  if (usedRef !== resolvedRef) {
    console.log(`[guard] Used source ref: ${usedRef}`);
  }

  if (failed) {
    process.exit(1);
  }

  console.log('[guard] VS Code token compatibility check passed.');
}

main().catch(error => {
  console.error('[guard] Error while checking VS Code tokens.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
