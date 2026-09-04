# Change Log

All notable changes to the "UI Font Changer for VS Code" extension will be documented in this file.

This project loosely follows [Keep a Changelog](http://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-09-04

### Fixed

- Detect protected VS Code installation folders before patching, instead of failing mid-write with a raw `EPERM: operation not permitted` error. On Windows, `fs.access` only reports the read-only attribute and ignores ACLs, so installs under `C:\Program Files` passed the old permission check and failed later.
- Replace permission errors with actionable, platform-specific guidance (run as administrator on Windows, take ownership of the install directory on macOS and Linux).

### Changed

- Add extra marketplace keywords.

## [1.0.1] - 2026-07-20

### Notes

- Update readme and npm dependencies

## [1.0.0] - 2026-07-20

### Notes

- This is the initial public release.