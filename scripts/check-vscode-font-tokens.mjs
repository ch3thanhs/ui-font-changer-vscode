#!/usr/bin/env node

const FILES = [
  'src/vs/workbench/browser/media/style.css',
  'src/vs/editor/standalone/browser/standalone-tokens.css',
  'src/vs/workbench/contrib/issue/browser/media/issueReporter.css',
  'src/vs/workbench/contrib/issue/browser/media/issueReporterOverlay.css',
];

const REQUIRED_TOKENS = {
  windows: ['Segoe WPC', 'Segoe UI'],
  macos: ['-apple-system', 'BlinkMacSystemFont'],
  linux: ['system-ui', 'Ubuntu', 'Droid Sans'],
};

const BASE_RAW_URL = 'https://raw.githubusercontent.com/microsoft/vscode/main';

async function fetchFile(path) {
  const url = `${BASE_RAW_URL}/${path}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'font-changer-ci-guard',
      Accept: 'text/plain',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${path} (${response.status} ${response.statusText})`);
  }

  return response.text();
}

function findMissingTokens(contentByPath) {
  const allContent = Object.values(contentByPath).join('\n');
  const missingByPlatform = {};

  for (const [platform, tokens] of Object.entries(REQUIRED_TOKENS)) {
    const missing = tokens.filter(token => !allContent.includes(token));
    if (missing.length > 0) {
      missingByPlatform[platform] = missing;
    }
  }

  return missingByPlatform;
}

function printFoundSummary(contentByPath) {
  for (const [platform, tokens] of Object.entries(REQUIRED_TOKENS)) {
    const found = tokens.filter(token =>
      Object.values(contentByPath).some(content => content.includes(token)),
    );
    console.log(`[guard] ${platform}: found ${found.length}/${tokens.length} tokens`);
  }
}

async function main() {
  const contentByPath = {};

  for (const path of FILES) {
    contentByPath[path] = await fetchFile(path);
  }

  printFoundSummary(contentByPath);

  const missingByPlatform = findMissingTokens(contentByPath);
  if (Object.keys(missingByPlatform).length > 0) {
    console.error('[guard] VS Code token compatibility check failed. Missing tokens:');
    for (const [platform, missing] of Object.entries(missingByPlatform)) {
      console.error(`  - ${platform}: ${missing.join(', ')}`);
    }
    process.exit(1);
  }

  console.log('[guard] VS Code token compatibility check passed.');
}

main().catch(error => {
  console.error('[guard] Error while checking VS Code tokens.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
