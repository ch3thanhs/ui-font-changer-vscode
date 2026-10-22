#!/usr/bin/env node

import * as fs from 'node:fs';

const STABLE_RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable';
const strict = process.argv.includes('--strict');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

function fail(message) {
  console.error(`[engine-guard] ERROR: ${message}`);
  process.exitCode = 1;
}

function warn(message) {
  console.warn(`[engine-guard] WARNING: ${message}`);
}

function parseVersion(value) {
  const match = /^[~^>=v\s]*(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined;
}

function compareVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

async function fetchLatestStableVersion() {
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
  const latest = Array.isArray(releases)
    ? releases.find(version => typeof version === 'string' && parseVersion(version))
    : undefined;
  if (!latest) {
    throw new Error('The latest stable release feed did not contain a version.');
  }

  return latest;
}

async function main() {
  const engineRange = packageJson.engines?.vscode;
  const typesRange = packageJson.devDependencies?.['@types/vscode'];
  const nodeTypesRange = packageJson.devDependencies?.['@types/node'];

  const engineVersion = parseVersion(engineRange);
  if (!engineVersion) {
    fail(`engines.vscode must be a concrete version range, found "${engineRange}".`);
    return;
  }

  const typesVersion = parseVersion(typesRange);
  if (!typesVersion) {
    fail(`@types/vscode must declare a concrete version, found "${typesRange}".`);
    return;
  }

  console.log(`[engine-guard] engines.vscode: ${engineRange}`);
  console.log(`[engine-guard] @types/vscode: ${typesRange}`);
  console.log(`[engine-guard] @types/node: ${nodeTypesRange}`);

  // This mirrors the check @vscode/vsce runs before packaging. Catching it in
  // CI avoids a release failing only when the VSIX is built.
  if (compareVersions(typesVersion, engineVersion) > 0) {
    fail('@types/vscode is newer than engines.vscode. Bump engines.vscode first or pin @types/vscode to an older release.');
  }

  let latestStable;
  try {
    latestStable = await fetchLatestStableVersion();
  } catch (error) {
    warn(`${error instanceof Error ? error.message : String(error)}`);
    warn('Skipping the latest stable version comparison.');
    return;
  }

  const latestVersion = parseVersion(latestStable);
  if (!latestVersion) {
    warn(`Could not parse the latest stable version "${latestStable}".`);
    return;
  }

  console.log(`[engine-guard] Latest stable VS Code: ${latestStable}`);

  if (compareVersions(engineVersion, latestVersion) > 0) {
    fail(
      `engines.vscode (${formatVersion(engineVersion)}) is newer than the latest stable VS Code (${latestStable}). `
      + 'The extension would not be installable on the latest release.',
    );
    return;
  }

  if (compareVersions(engineVersion, latestVersion) < 0) {
    const message = `engines.vscode (${formatVersion(engineVersion)}) is behind the latest stable VS Code (${latestStable}). `
      + 'Bump engines.vscode and @types/vscode together to keep supporting only the latest release.';
    if (strict) {
      fail(message);
    } else {
      warn(message);
    }
  }

  if (process.exitCode) {
    return;
  }

  if (engineVersion.major === 1 && latestVersion.major === 1 && engineVersion.minor === latestVersion.minor) {
    console.log('[engine-guard] Minimum supported VS Code matches the latest stable release.');
  }

  console.log('[engine-guard] VS Code engine check passed.');
}

main().catch(error => {
  console.error('[engine-guard] Error while checking the VS Code engine.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
