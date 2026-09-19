# Change Log

All notable changes to the "UI Font Changer for VS Code" extension will be documented in this file.

This project loosely follows [Keep a Changelog](http://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.0.4] - 2026-09-19

### Added

- Add SHA-256 backup manifests that detect missing or modified backup files before applying or restoring a font.
- Add compatibility testing for the minimum supported VS Code release, an intermediate release, latest stable, and scheduled Insiders builds.
- Add a security policy with private vulnerability-reporting guidance.

### Changed

- Move font utilities, asynchronous patching and backup management, and operation serialization into dedicated modules.
- Use promise-based filesystem operations throughout production code to avoid blocking the extension host during bundle updates.
- Serialize change, reapply, and restore operations and use unique temporary filenames for atomic writes.
- Pin VS Code source compatibility checks, validate expected tokens per source file, and require complete font-family matches in compiled bundles.
- Pin the VSIX packager and GitHub Actions dependencies for reproducible release builds.
- Run CI for both `main` and `dev` and enforce zero-warning ESLint and stricter TypeScript checks.

### Fixed

- Preserve longer Windows font families such as `Segoe UI Variable`, `Segoe UI Emoji`, and `Segoe Fluent Icons` during replacement.
- Refuse to reconstruct a missing pristine backup from a potentially patched live VS Code file.
- Preserve deterministic repeated font changes and byte-for-byte restoration across all supported UI surfaces.

## [1.0.3] - 2026-09-19

### Added

- Add a one-time welcome notification with actions to choose a font or open the documentation.
- Add a `UI Font Changer: Reapply Font` command to restore the selected font after VS Code updates replace patched files.
- Remember the current and recently used fonts and prioritize them in the font picker.
- Recover the current font from existing patched files when updating from an older extension version.
- Show a one-time notice before modifying VS Code installation files, with an option to open the project documentation.
- Add actions to copy permission-recovery instructions or open documentation when VS Code installation files are protected.

### Changed

- Validate the exact compiled VS Code bundles on Windows, macOS, and Linux before release while retaining the upstream source scan as an early warning.
- Upgrade the VS Code test runner to support the renamed executable in current macOS application bundles.
- Offer to close VS Code after changing or restoring the UI font so users can complete the required full application restart.
- Close the font picker silently when selection is cancelled.
- Validate and normalize manually entered font names, and confirm before applying a font that was not detected on the system.
- Show progress while discovering installed fonts and while applying or restoring VS Code UI files.
- Group commands under the `UI Font Changer` category and use clearer Command Palette titles.
- Report whether the Workbench UI, Agent windows, and Markdown Preview were fully, partially, or not updated after font changes and restores.
- Reduce the VSIX contents to runtime and Marketplace files by excluding development and test assets.

### Fixed

- Replace source font tokens in a single pass so names such as `Segoe UI Variable` are not corrupted by subsequent replacements.
- Stop system font discovery after 15 seconds and fall back to manual font entry instead of waiting indefinitely.
- Restore every modified file when an update fails, including the file whose write triggered the failure.
- Escape custom font names before inserting them into VS Code CSS and JavaScript bundles.
- Bind backups to the exact VS Code installation and build to prevent stale restores after updates.
- Preserve compatible backups when migrating from version 1.0.2 metadata.
- Replace installation files atomically after verifying their temporary copies.
- Reject release tags that do not match the extension version before packaging.

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