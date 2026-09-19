#!/usr/bin/env node

import * as fs from 'node:fs';

function fail(message) {
  console.error(`[release-version] ${message}`);
  process.exitCode = 1;
}

const releaseTag = process.argv[2] ?? process.env.RELEASE_TAG;
if (!releaseTag) {
  fail('Pass a release tag as an argument or set RELEASE_TAG.');
} else {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  const expectedTag = `v${packageJson.version}`;

  if (releaseTag !== expectedTag) {
    fail(`Release tag ${releaseTag} does not match package version ${packageJson.version} (${expectedTag}).`);
  } else {
    console.log(`[release-version] Release tag ${releaseTag} matches package version ${packageJson.version}.`);
  }
}