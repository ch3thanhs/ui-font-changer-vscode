#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';

const TARGETS = [
  {
    name: 'Workbench CSS',
    relativePath: path.join('out', 'vs', 'workbench', 'workbench.desktop.main.css'),
    required: true,
    checkTokens: true,
  },
  {
    name: 'Workbench JavaScript',
    relativePath: path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js'),
    required: true,
    checkTokens: true,
  },
  {
    name: 'Sessions CSS',
    relativePath: path.join('out', 'vs', 'sessions', 'sessions.desktop.main.css'),
    required: false,
    checkTokens: true,
  },
  {
    name: 'Sessions JavaScript',
    relativePath: path.join('out', 'vs', 'sessions', 'sessions.desktop.main.js'),
    required: false,
    checkTokens: true,
  },
  {
    name: 'Markdown CSS',
    relativePath: path.join('extensions', 'markdown-language-features', 'media', 'markdown.css'),
    required: true,
    checkTokens: false,
  },
];

const TOKENS_BY_PLATFORM = {
  win32: ['Segoe UI', 'Segoe WPC', 'Segoe'],
  darwin: ['BlinkMacSystemFont', '-apple-system'],
  linux: ['Droid Sans', 'Ubuntu', 'system-ui'],
};

const SKIPPED_DISCOVERY_DIRECTORIES = new Set(['extensions', 'user-data']);

function isVsCodeAppRoot(directory) {
  return path.basename(directory) === 'app'
    && path.basename(path.dirname(directory)).toLowerCase() === 'resources'
    && fs.existsSync(path.join(directory, 'package.json'))
    && fs.existsSync(path.join(directory, 'product.json'));
}

function findVsCodeAppRoots(directory, depth = 0) {
  if (!fs.existsSync(directory) || depth > 7) {
    return [];
  }

  if (isVsCodeAppRoot(directory)) {
    return [directory];
  }

  const roots = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIPPED_DISCOVERY_DIRECTORIES.has(entry.name)) {
      continue;
    }

    roots.push(...findVsCodeAppRoots(path.join(directory, entry.name), depth + 1));
  }

  return roots;
}

function readVsCodeVersion(appRoot) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf-8'));
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function resolveAppRoot() {
  const explicitRoot = process.argv[2] ?? process.env.VSCODE_APP_ROOT;
  if (explicitRoot) {
    const resolvedRoot = path.resolve(explicitRoot);
    if (!isVsCodeAppRoot(resolvedRoot)) {
      throw new Error(`The supplied VS Code app root is invalid: ${resolvedRoot}`);
    }

    return resolvedRoot;
  }

  const candidates = findVsCodeAppRoots(path.resolve('.vscode-test'));
  if (candidates.length === 0) {
    throw new Error('No downloaded VS Code app root was found. Run npm test first or pass an app root.');
  }

  return candidates.sort((left, right) =>
    readVsCodeVersion(right).localeCompare(readVsCodeVersion(left), undefined, { numeric: true })
  )[0];
}

function main() {
  const tokens = TOKENS_BY_PLATFORM[process.platform];
  if (!tokens) {
    throw new Error(`Unsupported validation platform: ${process.platform}`);
  }

  const appRoot = resolveAppRoot();
  const vscodeVersion = readVsCodeVersion(appRoot);
  let failed = false;

  console.log(`[bundle-guard] VS Code ${vscodeVersion} (${process.platform})`);
  console.log(`[bundle-guard] App root: ${appRoot}`);

  for (const target of TARGETS) {
    const targetPath = path.join(appRoot, target.relativePath);
    if (!fs.existsSync(targetPath)) {
      const message = `${target.name} is missing: ${target.relativePath}`;
      if (target.required) {
        console.error(`[bundle-guard] ERROR: ${message}`);
        failed = true;
      } else {
        console.warn(`[bundle-guard] WARNING: ${message}`);
      }
      continue;
    }

    if (!target.checkTokens) {
      console.log(`[bundle-guard] PASS: ${target.name} exists`);
      continue;
    }

    const content = fs.readFileSync(targetPath, 'utf-8');
    const foundTokens = tokens.filter(token => content.includes(token));
    if (foundTokens.length === 0) {
      console.error(
        `[bundle-guard] ERROR: ${target.name} contains none of the expected tokens: ${tokens.join(', ')}`,
      );
      failed = true;
      continue;
    }

    console.log(`[bundle-guard] PASS: ${target.name} contains ${foundTokens.join(', ')}`);
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log('[bundle-guard] Compiled VS Code bundle compatibility check passed.');
}

try {
  main();
} catch (error) {
  console.error('[bundle-guard] Compiled VS Code bundle compatibility check failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}