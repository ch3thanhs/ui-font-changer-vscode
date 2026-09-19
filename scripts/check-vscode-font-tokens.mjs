#!/usr/bin/env node

const DEFAULT_VSCODE_REF = '1.85.0';
const VSCODE_REF = process.argv[2] ?? process.env.VSCODE_SOURCE_REF ?? DEFAULT_VSCODE_REF;
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

const BASE_RAW_URL = `https://raw.githubusercontent.com/microsoft/vscode/${encodeURIComponent(VSCODE_REF)}`;

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

async function main() {
  let failed = false;
  console.log(`[guard] VS Code source ref: ${VSCODE_REF}`);

  for (const [path, expectations] of Object.entries(EXPECTATIONS_BY_FILE)) {
    const content = await fetchFile(path);
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
