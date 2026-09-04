import * as fs from 'fs';
import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';

/** Font strings inside workbench/sessions bundles that get replaced. Order matters:
 *  more-specific names must come first so they aren't pre-consumed by 'Segoe'. */
export const DEFAULT_FONTS_TO_REPLACE: ReadonlyArray<string> = ['Segoe UI', 'Segoe WPC', 'Segoe'];
export const MACOS_FONTS_TO_REPLACE: ReadonlyArray<string> = ['BlinkMacSystemFont', '-apple-system'];
export const LINUX_FONTS_TO_REPLACE: ReadonlyArray<string> = ['Droid Sans', 'Ubuntu', 'system-ui'];

const execFileAsync = promisify(execFile);
const WINDOWS_PLATFORM = 'win32';
const MACOS_PLATFORM = 'darwin';
const LINUX_PLATFORM = 'linux';
const BACKUP_METADATA_VERSION = 1;

export interface TargetFiles {
    workbenchCss: string;
    workbenchJs: string;
    sessionsCss: string;
    sessionsJs: string;
    markdownCss: string;
}

interface BackupFiles {
    root: string;
    metadata: string;
    workbenchCss: string;
    workbenchJs: string;
    sessionsCss: string;
    sessionsJs: string;
    markdownCss: string;
}

interface BackupMetadata {
    version: number;
    vscodeVersion: string;
    appName: string;
}

interface PlannedFileWrite {
    targetPath: string;
    content: string;
}

class FileAccessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileAccessError';
    }
}

class FileVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileVerificationError';
    }
}

/** Resolve all target file paths relative to a VS Code installation root. */
export function getTargetFiles(appRoot: string): TargetFiles {
    return {
        workbenchCss: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.css'),
        workbenchJs: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
        // The "Open in Agents" window is a separate Electron window backed by its own bundle.
        sessionsCss: path.join(appRoot, 'out', 'vs', 'sessions', 'sessions.desktop.main.css'),
        sessionsJs: path.join(appRoot, 'out', 'vs', 'sessions', 'sessions.desktop.main.js'),
        markdownCss: path.join(appRoot, 'extensions', 'markdown-language-features', 'media', 'markdown.css'),
    };
}

/** Replace every occurrence of each name in `namesToReplace` with `fontName` inside `content`.
 *  Pure function — safe to unit-test in isolation. */
export function replaceFontInContent(
    content: string,
    fontName: string,
    namesToReplace: ReadonlyArray<string> = DEFAULT_FONTS_TO_REPLACE,
): string {
    return namesToReplace.reduce((acc, name) => {
        const regex = new RegExp(`(["']?)${escapeRegExp(name)}\\1`, 'g');
        return acc.replace(regex, (match, quote: string) => {
            if (quote) {
                return `${quote}${fontName}${quote}`;
            }

            return formatFontFamily(fontName);
        });
    }, content);
}

export function containsTargetFontReferences(
    content: string,
    namesToReplace: ReadonlyArray<string> = DEFAULT_FONTS_TO_REPLACE,
): boolean {
    return namesToReplace.some(name => content.includes(name));
}

export function getDefaultFontsToReplaceForPlatform(platform: string): ReadonlyArray<string> {
    if (platform === WINDOWS_PLATFORM) {
        return DEFAULT_FONTS_TO_REPLACE;
    }

    if (platform === MACOS_PLATFORM) {
        return MACOS_FONTS_TO_REPLACE;
    }

    if (platform === LINUX_PLATFORM) {
        return LINUX_FONTS_TO_REPLACE;
    }

    return DEFAULT_FONTS_TO_REPLACE;
}

/** Build the markdown.css block that forces the Markdown preview to use the chosen font. */
export function buildMarkdownRule(fontName: string): string {
    return `html, body {\n\tfont-family: "${fontName}" !important;\n}`;
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatFontFamily(fontName: string): string {
    // Use single quotes for inserted multi-word names so embedded JS string literals stay valid.
    return /^[-_a-zA-Z][-_a-zA-Z0-9]*$/.test(fontName) ? fontName : `'${fontName.replace(/'/g, "\\'")}'`;
}

function getBackupFiles(context: vscode.ExtensionContext): BackupFiles {
    const backupRoot = path.join(context.globalStorageUri.fsPath, 'ui-font-changer-for-vscode-backups');

    return {
        root: backupRoot,
        metadata: path.join(backupRoot, 'metadata.json'),
        workbenchCss: path.join(backupRoot, 'workbench.desktop.main.css.bak'),
        workbenchJs: path.join(backupRoot, 'workbench.desktop.main.js.bak'),
        sessionsCss: path.join(backupRoot, 'sessions.desktop.main.css.bak'),
        sessionsJs: path.join(backupRoot, 'sessions.desktop.main.js.bak'),
        markdownCss: path.join(backupRoot, 'markdown.css.bak'),
    };
}

function getBackupContentPaths(backups: BackupFiles): string[] {
    return [
        backups.workbenchCss,
        backups.workbenchJs,
        backups.sessionsCss,
        backups.sessionsJs,
        backups.markdownCss,
    ];
}

function getCurrentBackupMetadata(): BackupMetadata {
    return {
        version: BACKUP_METADATA_VERSION,
        vscodeVersion: vscode.version,
        appName: vscode.env.appName,
    };
}

export function isBackupMetadataCurrent(metadata: BackupMetadata, currentMetadata: BackupMetadata): boolean {
    return metadata.version === currentMetadata.version
        && metadata.vscodeVersion === currentMetadata.vscodeVersion
        && metadata.appName === currentMetadata.appName;
}

function readBackupMetadata(backups: BackupFiles): BackupMetadata | undefined {
    if (!fs.existsSync(backups.metadata)) {
        return undefined;
    }

    try {
        const content = fs.readFileSync(backups.metadata, 'utf-8');
        return JSON.parse(content) as BackupMetadata;
    } catch {
        return undefined;
    }
}

function writeJsonAtomically(filePath: string, data: unknown): void {
    writeTextAtomically(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function verifyFileContent(filePath: string, expectedContent: string): void {
    const writtenContent = fs.readFileSync(filePath, 'utf-8');
    if (writtenContent !== expectedContent) {
        throw new FileVerificationError(
            `UI Font Changer for VS Code could not verify the updated contents of ${describePathForUser(filePath)}.`,
        );
    }
}

function writeTextAtomically(filePath: string, content: string): void {
    const tempPath = `${filePath}.ui-font-changer-for-vscode.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.copyFileSync(tempPath, filePath);
    // Verify before deleting the temp file so a failed write still leaves a recoverable copy on disk.
    verifyFileContent(filePath, content);
    fs.unlinkSync(tempPath);
}

function resetBackupSet(backups: BackupFiles): void {
    fs.rmSync(backups.root, { recursive: true, force: true });
}

function describePathForUser(filePath: string): string {
    return path.basename(filePath);
}

function isPermissionError(error: unknown): boolean {
    return !!error
        && typeof error === 'object'
        && 'code' in error
        && (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS');
}

export function getElevationHint(platform: string = process.platform): string {
    if (platform === WINDOWS_PLATFORM) {
        return 'The VS Code installation folder is protected. Close VS Code, right-click its shortcut, choose "Run as administrator", and run the command again.';
    }

    if (platform === MACOS_PLATFORM) {
        return 'The VS Code installation folder is not writable by your user account. Grant yourself write access (for example: sudo chown -R "$(whoami)" "/Applications/Visual Studio Code.app") and run the command again.';
    }

    return 'The VS Code installation folder is not writable by your user account. Grant yourself write access to the installation directory (for example: sudo chown -R "$(whoami)" /usr/share/code) and run the command again.';
}

function ensureDirectoryWritable(dirPath: string, purpose: string): void {
    let probeHandle: number | undefined;
    // fs.accessSync(W_OK) only reflects the read-only attribute on Windows and ignores ACLs,
    // so probe with a real file creation to catch protected locations like C:\Program Files.
    const probePath = path.join(dirPath, `.ui-font-changer-for-vscode-probe-${process.pid}-${Date.now()}`);

    try {
        fs.mkdirSync(dirPath, { recursive: true });
        probeHandle = fs.openSync(probePath, 'wx');
    } catch (error) {
        if (isPermissionError(error)) {
            throw new FileAccessError(
                `UI Font Changer for VS Code could not write to ${purpose}. ${getElevationHint()}`,
            );
        }

        throw error;
    } finally {
        if (probeHandle !== undefined) {
            fs.closeSync(probeHandle);
            try {
                fs.unlinkSync(probePath);
            } catch {
                // Leftover probe files are harmless; never fail the command over cleanup.
            }
        }
    }
}

function ensureFileReadableWritable(filePath: string, purpose: string): void {
    let handle: number | undefined;

    try {
        // Opening for read/write is the only reliable write check on Windows.
        handle = fs.openSync(filePath, 'r+');
    } catch (error) {
        if (isPermissionError(error)) {
            throw new FileAccessError(
                `UI Font Changer for VS Code could not modify ${purpose} (${describePathForUser(filePath)}). ${getElevationHint()}`,
            );
        }

        throw error;
    } finally {
        if (handle !== undefined) {
            fs.closeSync(handle);
        }
    }
}

function preflightPatchTargets(targets: Array<{ target: string }>, backupRoot: string): void {
    ensureDirectoryWritable(backupRoot, 'backup storage');

    targets.forEach(({ target }) => {
        if (!fs.existsSync(target)) {
            return;
        }

        ensureFileReadableWritable(target, 'a VS Code UI file');
        ensureDirectoryWritable(path.dirname(target), `the directory containing ${describePathForUser(target)}`);
    });
}

function preflightRestoreTargets(targets: Array<{ target: string; backup: string }>, backupRoot: string): void {
    ensureDirectoryWritable(backupRoot, 'backup storage');

    targets.forEach(({ target, backup }) => {
        if (!fs.existsSync(target) || !fs.existsSync(backup)) {
            return;
        }

        // Restore rewrites the live install file, so the target still needs write access even though content comes from backup.
        ensureFileReadableWritable(target, 'a VS Code UI file');
        ensureFileReadableWritable(backup, 'a backup file');
        ensureDirectoryWritable(path.dirname(target), `the directory containing ${describePathForUser(target)}`);
    });
}

function toUserFacingErrorMessage(error: unknown): string {
    if (error instanceof FileVerificationError) {
        return error.message;
    }

    if (error instanceof FileAccessError) {
        return error.message;
    }

    if (isPermissionError(error)) {
        return `UI Font Changer for VS Code could not modify the VS Code installation files. ${getElevationHint()}`;
    }

    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return `Error: ${error.message}`;
    }

    return `Error: ${String(error)}`;
}

function prepareBackupSet(backups: BackupFiles): void {
    const currentMetadata = getCurrentBackupMetadata();
    const existingMetadata = readBackupMetadata(backups);
    const hasExistingBackups = getBackupContentPaths(backups).some(filePath => fs.existsSync(filePath));

    // Never restore bundles across VS Code builds; upstream assets can change shape between versions.
    if (hasExistingBackups && (!existingMetadata || !isBackupMetadataCurrent(existingMetadata, currentMetadata))) {
        resetBackupSet(backups);
    }

    fs.mkdirSync(backups.root, { recursive: true });

    const refreshedMetadata = readBackupMetadata(backups);
    if (!refreshedMetadata || !isBackupMetadataCurrent(refreshedMetadata, currentMetadata)) {
        writeJsonAtomically(backups.metadata, currentMetadata);
    }
}

function buildPatchedFontFileContent(
    content: string,
    fontName: string,
    filePath: string,
    namesToReplace: ReadonlyArray<string>,
): string {
    // Treat missing Segoe tokens as a compatibility break instead of silently writing a no-op bundle.
    if (!containsTargetFontReferences(content, namesToReplace)) {
        throw new FileVerificationError(
            `UI Font Changer for VS Code could not find the expected font tokens in ${describePathForUser(filePath)}.`,
        );
    }

    const updatedContent = replaceFontInContent(content, fontName, namesToReplace);
    if (updatedContent === content) {
        throw new FileVerificationError(
            `UI Font Changer for VS Code could not update ${describePathForUser(filePath)} with the selected font.`,
        );
    }

    return updatedContent;
}

function applyWritesTransactionally(writes: PlannedFileWrite[]): void {
    const originals = new Map<string, string>();
    const writtenPaths: string[] = [];

    writes.forEach(write => {
        originals.set(write.targetPath, fs.readFileSync(write.targetPath, 'utf-8'));
    });

    try {
        writes.forEach(write => {
            writeTextAtomically(write.targetPath, write.content);
            writtenPaths.push(write.targetPath);
        });
    } catch (error) {
        const rollbackFailures: string[] = [];

        // Roll back only files we have already touched in this batch so we don't leave a mixed install behind.
        writtenPaths.reverse().forEach(targetPath => {
            const originalContent = originals.get(targetPath);
            if (originalContent === undefined) {
                return;
            }

            try {
                writeTextAtomically(targetPath, originalContent);
            } catch (rollbackError) {
                rollbackFailures.push(`${describePathForUser(targetPath)}: ${toUserFacingErrorMessage(rollbackError)}`);
            }
        });

        if (rollbackFailures.length > 0) {
            throw new FileVerificationError(
                `UI Font Changer for VS Code failed to update the VS Code UI files and could not fully roll back changes. ${rollbackFailures.join(' | ')}`,
            );
        }

        throw error;
    }
}

function planFontPatchWrites(
    filesToModify: Array<{ target: string; backup: string }>,
    fontName: string,
    namesToReplace: ReadonlyArray<string>,
): PlannedFileWrite[] {
    const plannedWrites: PlannedFileWrite[] = [];

    filesToModify.forEach(({ target, backup }) => {
        if (!fs.existsSync(target)) {
            return;
        }

        ensureBackup(target, backup);
        // Always patch from the pristine backup, not the currently installed file, so repeated runs stay deterministic.
        const backupContent = fs.readFileSync(backup, 'utf-8');
        plannedWrites.push({
            targetPath: target,
            content: buildPatchedFontFileContent(backupContent, fontName, target, namesToReplace),
        });
    });

    return plannedWrites;
}

function planMarkdownPatchWrite(targetPath: string, backupPath: string, fontName: string): PlannedFileWrite | undefined {
    if (!fs.existsSync(targetPath)) {
        return undefined;
    }

    ensureBackup(targetPath, backupPath);
    const backupContent = fs.readFileSync(backupPath, 'utf-8');
    return {
        targetPath,
        // Markdown preview uses an additive rule instead of token replacement, so restore from backup first and append once.
        content: `${backupContent}\n${buildMarkdownRule(fontName)}`,
    };
}

function planRestoreWrites(filesToRestore: Array<{ target: string; backup: string }>): PlannedFileWrite[] {
    const plannedWrites: PlannedFileWrite[] = [];

    filesToRestore.forEach(({ target, backup }) => {
        if (!fs.existsSync(target) || !fs.existsSync(backup)) {
            return;
        }

        plannedWrites.push({
            targetPath: target,
            content: fs.readFileSync(backup, 'utf-8'),
        });
    });

    return plannedWrites;
}

function hasRestorableBackupSet(backups: BackupFiles): boolean {
    const metadata = readBackupMetadata(backups);
    if (!metadata || !isBackupMetadataCurrent(metadata, getCurrentBackupMetadata())) {
        return false;
    }

    return getBackupContentPaths(backups).some(filePath => fs.existsSync(filePath));
}

function ensureBackup(contentPath: string, backupPath: string): void {
    if (fs.existsSync(backupPath)) {
        return;
    }

    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(contentPath, backupPath);
}

export function normalizeFontFamilyName(name: string): string {
    return name
        .trim()
        .replace(/^"(.+)"$/, '$1')
        .replace(/\s*\((?:TrueType|OpenType|Type 1|Raster)\)$/i, '')
        .trim();
}

export function parseInstalledFontList(rawOutput: string): string[] {
    const fonts = new Set<string>();

    rawOutput.split(/\r?\n/).forEach(line => {
        const familySegment = line.split(':', 1)[0] ?? line;

        familySegment.split(',').forEach(entry => {
            const font = normalizeFontFamilyName(entry);
            if (font) {
                fonts.add(font);
            }
        });
    });

    return [...fonts].sort((left, right) => left.localeCompare(right));
}

async function getInstalledFonts(): Promise<string[]> {
    try {
        if (process.platform === WINDOWS_PLATFORM) {
            const script = [
                'Add-Type -AssemblyName System.Drawing',
                '$fonts = New-Object System.Drawing.Text.InstalledFontCollection',
                '$fonts.Families | ForEach-Object { $_.Name } | Sort-Object -Unique',
            ].join('\n');

            const { stdout } = await execFileAsync('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                script,
            ]);

            const fonts = parseInstalledFontList(stdout);
            if (fonts.length > 0) {
                return fonts;
            }

            return [];
        }

        const { stdout } = await execFileAsync('fc-list', [':', 'family']);
        const fonts = parseInstalledFontList(stdout);
        if (fonts.length > 0) {
            return fonts;
        }

        return [];
    } catch {
        return [];
    }
}

interface FontQuickPickItem extends vscode.QuickPickItem {
    fontName: string;
}

async function pickFontName(): Promise<string | undefined> {
    const installedFonts = await getInstalledFonts();

    if (installedFonts.length === 0) {
        // Font enumeration can fail on some machines, but manual entry should still keep the command usable.
        return vscode.window.showInputBox({
            prompt: 'Enter the font name',
            placeHolder: 'e.g., Inter',
            value: 'Inter',
        });
    }

    const quickPickItems: FontQuickPickItem[] = [
        {
            label: '$(edit) Enter a custom font...',
            description: 'Type a font name manually',
            fontName: '',
        },
        ...installedFonts.map(fontName => ({
            label: fontName,
            fontName,
        })),
    ];

    const selectedFont = await vscode.window.showQuickPick(quickPickItems, {
        title: 'Select the UI font',
        placeHolder: 'Choose an installed font or enter a custom one',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (!selectedFont) {
        return undefined;
    }

    if (selectedFont.fontName) {
        return selectedFont.fontName;
    }

    return vscode.window.showInputBox({
        prompt: 'Enter the font name',
        placeHolder: 'e.g., Inter',
        value: 'Inter',
    });
}

export function activate(context: vscode.ExtensionContext) {

    const targets = getTargetFiles(vscode.env.appRoot);
    const backups = getBackupFiles(context);
    const namesToReplace = getDefaultFontsToReplaceForPlatform(process.platform);

    let disposable = vscode.commands.registerCommand('ui-font-changer-for-vscode.change', async () => {
        const fontName = await pickFontName();

        if (fontName) {
            try {
                const filesToModify = [
                    { target: targets.workbenchCss, backup: backups.workbenchCss },
                    { target: targets.workbenchJs, backup: backups.workbenchJs },
                    { target: targets.sessionsCss, backup: backups.sessionsCss },
                    { target: targets.sessionsJs, backup: backups.sessionsJs },
                ];

                preflightPatchTargets([
                    ...filesToModify,
                    { target: targets.markdownCss },
                ], backups.root);
                prepareBackupSet(backups);

                const plannedWrites = planFontPatchWrites(filesToModify, fontName, namesToReplace);
                const markdownWrite = planMarkdownPatchWrite(targets.markdownCss, backups.markdownCss, fontName);
                if (markdownWrite) {
                    plannedWrites.push(markdownWrite);
                }

                if (plannedWrites.length === 0) {
                    vscode.window.showWarningMessage('No compatible VS Code UI files were found to update.');
                    return;
                }

                applyWritesTransactionally(plannedWrites);

                vscode.window.showInformationMessage(`Font changed to ${fontName}. Restart VS Code to apply.`);
            } catch (error: any) {
                vscode.window.showErrorMessage(toUserFacingErrorMessage(error));
            }
        } else {
            vscode.window.showWarningMessage('Font name not provided.');
        }
    });

    const restoreDisposable = vscode.commands.registerCommand('ui-font-changer-for-vscode.restore', async () => {
        if (!hasRestorableBackupSet(backups)) {
            vscode.window.showWarningMessage('No compatible font backup was found for this VS Code build.');
            return;
        }

        try {
            const filesToRestore = [
                { target: targets.workbenchCss, backup: backups.workbenchCss },
                { target: targets.workbenchJs, backup: backups.workbenchJs },
                { target: targets.sessionsCss, backup: backups.sessionsCss },
                { target: targets.sessionsJs, backup: backups.sessionsJs },
                { target: targets.markdownCss, backup: backups.markdownCss },
            ];

            preflightRestoreTargets(filesToRestore, backups.root);

            const plannedWrites = planRestoreWrites(filesToRestore);
            const restoredAnyFile = plannedWrites.length > 0;

            if (!restoredAnyFile) {
                vscode.window.showWarningMessage('No backup files were available to restore for this VS Code build.');
                return;
            }

            applyWritesTransactionally(plannedWrites);

            vscode.window.showInformationMessage('Original VS Code fonts restored. Restart VS Code to apply.');
        } catch (error: any) {
            vscode.window.showErrorMessage(toUserFacingErrorMessage(error));
        }
    });

    context.subscriptions.push(disposable, restoreDisposable);
}

export function deactivate() {}
