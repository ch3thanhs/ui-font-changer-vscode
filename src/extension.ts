import * as fs from 'fs';
import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';

/** Font strings inside workbench/sessions bundles that get replaced. */
export const DEFAULT_FONTS_TO_REPLACE: ReadonlyArray<string> = ['Segoe UI', 'Segoe WPC', 'Segoe'];
export const MACOS_FONTS_TO_REPLACE: ReadonlyArray<string> = ['BlinkMacSystemFont', '-apple-system'];
export const LINUX_FONTS_TO_REPLACE: ReadonlyArray<string> = ['Droid Sans', 'Ubuntu', 'system-ui'];

const execFileAsync = promisify(execFile);
const WINDOWS_PLATFORM = 'win32';
const MACOS_PLATFORM = 'darwin';
const LINUX_PLATFORM = 'linux';
const BACKUP_METADATA_VERSION = 2;
const CURRENT_FONT_KEY = 'currentFont';
const RECENT_FONTS_KEY = 'recentFonts';
const MODIFICATION_NOTICE_ACCEPTED_KEY = 'modificationNoticeAccepted';
const WELCOME_NOTIFICATION_SHOWN_KEY = 'welcomeNotificationShown';
const MAX_RECENT_FONTS = 5;
export const FONT_ENUMERATION_TIMEOUT_MS = 15_000;
const DOCUMENTATION_URL = 'https://github.com/ch3thanhs/ui-font-changer-vscode#readme';

export interface TargetFiles {
    workbenchCss: string;
    workbenchJs: string;
    sessionsCss: string;
    sessionsJs: string;
    markdownCss: string;
}

export interface BackupFiles {
    root: string;
    metadata: string;
    workbenchCss: string;
    workbenchJs: string;
    sessionsCss: string;
    sessionsJs: string;
    markdownCss: string;
}

export interface BackupMetadata {
    version: number;
    vscodeVersion: string;
    appName: string;
    appRoot: string;
    buildId: string;
}

export interface PlannedFileWrite {
    targetPath: string;
    content: string;
}

export interface SurfaceUpdate {
    name: string;
    status: 'updated' | 'partial' | 'unavailable';
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

export function summarizeSurfaceUpdates(
    targets: TargetFiles,
    writes: ReadonlyArray<{ targetPath: string }>,
): SurfaceUpdate[] {
    const writtenPaths = new Set(writes.map(write => write.targetPath));
    const surfaces = [
        { name: 'Workbench UI', paths: [targets.workbenchCss, targets.workbenchJs] },
        { name: 'Agent windows', paths: [targets.sessionsCss, targets.sessionsJs] },
        { name: 'Markdown Preview', paths: [targets.markdownCss] },
    ];

    return surfaces.map(surface => {
        const writtenCount = surface.paths.filter(targetPath => writtenPaths.has(targetPath)).length;
        const status = writtenCount === surface.paths.length
            ? 'updated'
            : writtenCount > 0
                ? 'partial'
                : 'unavailable';

        return { name: surface.name, status };
    });
}

/** Replace every occurrence of each name in `namesToReplace` with `fontName` inside `content`.
 *  Pure function — safe to unit-test in isolation. */
export function replaceFontInContent(
    content: string,
    fontName: string,
    namesToReplace: ReadonlyArray<string> = DEFAULT_FONTS_TO_REPLACE,
): string {
    assertSafeFontName(fontName);

    if (namesToReplace.length === 0) {
        return content;
    }

    const alternatives = [...namesToReplace]
        .sort((left, right) => right.length - left.length)
        .map(escapeRegExp)
        .join('|');
    const regex = new RegExp(`(["']?)(?:${alternatives})\\1`, 'g');

    return content.replace(regex, (match, quote: string) => {
        if (quote) {
            return `${quote}${escapeFontNameForQuote(fontName, quote)}${quote}`;
        }

        return formatFontFamily(fontName);
    });
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
    assertSafeFontName(fontName);
    return `html, body {\n\tfont-family: "${escapeFontNameForQuote(fontName, '"')}" !important;\n}`;
}

export function detectPatchedMarkdownFont(backupContent: string, currentContent: string): string | undefined {
    const appendedRulePrefix = `${backupContent}\n`;
    if (!currentContent.startsWith(appendedRulePrefix)) {
        return undefined;
    }

    const appendedContent = currentContent.slice(appendedRulePrefix.length);
    const match = /^html, body \{\n\tfont-family: "((?:\\.|[^"\\\r\n])+)" !important;\n\}$/.exec(appendedContent);
    return match ? unescapeFontNameForQuote(match[1]) : undefined;
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const INVALID_FONT_NAME_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/;

function assertSafeFontName(fontName: string): void {
    if (!fontName || INVALID_FONT_NAME_CHARACTERS.test(fontName)) {
        throw new Error('Font names cannot be empty or contain control characters.');
    }
}

function escapeFontNameForQuote(fontName: string, quote: string): string {
    const quotePattern = quote === '"' ? /"/g : /'/g;
    return fontName.replace(/\\/g, '\\\\').replace(quotePattern, `\\${quote}`);
}

function unescapeFontNameForQuote(fontName: string): string {
    return fontName.replace(/\\(["\\])/g, '$1');
}

function formatFontFamily(fontName: string): string {
    // Use single quotes for inserted multi-word names so embedded JS string literals stay valid.
    return /^[-_a-zA-Z][-_a-zA-Z0-9]*$/.test(fontName)
        ? fontName
        : `'${escapeFontNameForQuote(fontName, "'")}'`;
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

function getVsCodeBuildId(appRoot: string): string {
    try {
        const productJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'product.json'), 'utf-8')) as {
            commit?: unknown;
        };
        if (typeof productJson.commit === 'string' && productJson.commit) {
            return productJson.commit;
        }
    } catch {
        // The installation root still distinguishes versioned layouts when product metadata is unavailable.
    }

    return appRoot;
}

function getCurrentBackupMetadata(): BackupMetadata {
    return {
        version: BACKUP_METADATA_VERSION,
        vscodeVersion: vscode.version,
        appName: vscode.env.appName,
        appRoot: vscode.env.appRoot,
        buildId: getVsCodeBuildId(vscode.env.appRoot),
    };
}

export function isBackupMetadataCurrent(metadata: BackupMetadata, currentMetadata: BackupMetadata): boolean {
    return metadata.version === currentMetadata.version
        && metadata.vscodeVersion === currentMetadata.vscodeVersion
        && metadata.appName === currentMetadata.appName
        && metadata.appRoot === currentMetadata.appRoot
        && metadata.buildId === currentMetadata.buildId;
}

    function isLegacyBackupMetadataCompatible(metadata: BackupMetadata, currentMetadata: BackupMetadata): boolean {
        return metadata.version === 1
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

    try {
        fs.writeFileSync(tempPath, content, 'utf-8');
        verifyFileContent(tempPath, content);
        fs.renameSync(tempPath, filePath);
        verifyFileContent(filePath, content);
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
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

async function showUserFacingError(error: unknown): Promise<void> {
    const message = toUserFacingErrorMessage(error);
    if (!(error instanceof FileAccessError) && !isPermissionError(error)) {
        await vscode.window.showErrorMessage(message);
        return;
    }

    const copyAction = 'Copy Instructions';
    const documentationAction = 'Open Documentation';
    const selectedAction = await vscode.window.showErrorMessage(
        message,
        copyAction,
        documentationAction,
    );

    if (selectedAction === copyAction) {
        await vscode.env.clipboard.writeText(message);
        await vscode.window.showInformationMessage('Permission instructions copied.');
    } else if (selectedAction === documentationAction) {
        await vscode.env.openExternal(vscode.Uri.parse(DOCUMENTATION_URL));
    }
}

export function prepareBackupSet(
    backups: BackupFiles,
    currentMetadata: BackupMetadata = getCurrentBackupMetadata(),
): void {
    const existingMetadata = readBackupMetadata(backups);
    const hasExistingBackups = getBackupContentPaths(backups).some(filePath => fs.existsSync(filePath));
    const canMigrateLegacyMetadata = !!existingMetadata
        && isLegacyBackupMetadataCompatible(existingMetadata, currentMetadata);

    // Never restore bundles across VS Code builds; upstream assets can change shape between versions.
    if (hasExistingBackups
        && !canMigrateLegacyMetadata
        && (!existingMetadata || !isBackupMetadataCurrent(existingMetadata, currentMetadata))) {
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

export function applyWritesTransactionally(
    writes: PlannedFileWrite[],
    writeText: (filePath: string, content: string) => void = writeTextAtomically,
): void {
    const originals = new Map<string, string>();
    const writtenPaths: string[] = [];

    writes.forEach(write => {
        originals.set(write.targetPath, fs.readFileSync(write.targetPath, 'utf-8'));
    });

    try {
        writes.forEach(write => {
            writtenPaths.push(write.targetPath);
            writeText(write.targetPath, write.content);
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

export function planFontPatchWrites(
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

export function planMarkdownPatchWrite(
    targetPath: string,
    backupPath: string,
    fontName: string,
): PlannedFileWrite | undefined {
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

export function planRestoreWrites(
    filesToRestore: Array<{ target: string; backup: string }>,
): PlannedFileWrite[] {
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

export function hasRestorableBackupSet(
    backups: BackupFiles,
    currentMetadata: BackupMetadata = getCurrentBackupMetadata(),
): boolean {
    const metadata = readBackupMetadata(backups);
    if (!metadata
        || (!isBackupMetadataCurrent(metadata, currentMetadata)
            && !isLegacyBackupMetadataCompatible(metadata, currentMetadata))) {
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

export function normalizeCustomFontName(fontName: string): string {
    return normalizeFontFamilyName(fontName);
}

export function getFontNameValidationError(fontName: string): string | undefined {
    const normalizedFontName = normalizeCustomFontName(fontName);
    if (!normalizedFontName) {
        return 'Enter a font name.';
    }

    if (INVALID_FONT_NAME_CHARACTERS.test(normalizedFontName)) {
        return 'Font names cannot contain control characters.';
    }

    return undefined;
}

export function isInstalledFont(fontName: string, installedFonts: ReadonlyArray<string>): boolean {
    return installedFonts.some(installedFont =>
        installedFont.localeCompare(fontName, undefined, { sensitivity: 'accent' }) === 0,
    );
}

export interface FontCommandOptions {
    timeout: number;
    windowsHide: boolean;
}

export type FontCommandRunner = (
    command: string,
    args: string[],
    options: FontCommandOptions,
) => Promise<string>;

const executeFontCommand: FontCommandRunner = async (command, args, options) => {
    const { stdout } = await execFileAsync(command, args, {
        encoding: 'utf-8',
        timeout: options.timeout,
        windowsHide: options.windowsHide,
    });
    return stdout;
};

export async function getInstalledFonts(
    platform: string = process.platform,
    runCommand: FontCommandRunner = executeFontCommand,
): Promise<string[]> {
    const commandOptions: FontCommandOptions = {
        timeout: FONT_ENUMERATION_TIMEOUT_MS,
        windowsHide: true,
    };

    try {
        if (platform === WINDOWS_PLATFORM) {
            const script = [
                'Add-Type -AssemblyName System.Drawing',
                '$fonts = New-Object System.Drawing.Text.InstalledFontCollection',
                '$fonts.Families | ForEach-Object { $_.Name } | Sort-Object -Unique',
            ].join('\n');

            const stdout = await runCommand('powershell.exe', [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                script,
            ], commandOptions);

            const fonts = parseInstalledFontList(stdout);
            if (fonts.length > 0) {
                return fonts;
            }

            return [];
        }

        const stdout = await runCommand('fc-list', [':', 'family'], commandOptions);
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

async function promptForCustomFont(installedFonts: ReadonlyArray<string>): Promise<string | undefined> {
    const enteredFontName = await vscode.window.showInputBox({
        prompt: 'Enter the font name',
        placeHolder: 'e.g., Inter',
        value: 'Inter',
        validateInput: getFontNameValidationError,
    });

    if (enteredFontName === undefined) {
        return undefined;
    }

    const fontName = normalizeCustomFontName(enteredFontName);
    if (!fontName) {
        return undefined;
    }

    if (installedFonts.length === 0 || isInstalledFont(fontName, installedFonts)) {
        return fontName;
    }

    const useAnywayAction = 'Use Anyway';
    const selectedAction = await vscode.window.showWarningMessage(
        `The font "${fontName}" was not found among installed system fonts.`,
        { modal: true },
        useAnywayAction,
    );
    return selectedAction === useAnywayAction ? fontName : undefined;
}

export function prioritizeFontNames(
    installedFonts: ReadonlyArray<string>,
    currentFont: string | undefined,
    recentFonts: ReadonlyArray<string>,
): string[] {
    const prioritizedFonts: string[] = [];
    const seenFonts = new Set<string>();

    [currentFont, ...recentFonts, ...installedFonts].forEach(fontName => {
        const normalizedFontName = fontName?.trim();
        const comparisonKey = normalizedFontName?.toLocaleLowerCase();
        if (!normalizedFontName || !comparisonKey || seenFonts.has(comparisonKey)) {
            return;
        }

        seenFonts.add(comparisonKey);
        prioritizedFonts.push(normalizedFontName);
    });

    return prioritizedFonts;
}

async function rememberFontSelection(context: vscode.ExtensionContext, fontName: string): Promise<void> {
    const recentFonts = context.globalState.get<string[]>(RECENT_FONTS_KEY, []);
    const updatedRecentFonts = prioritizeFontNames([], fontName, recentFonts).slice(0, MAX_RECENT_FONTS);

    await Promise.all([
        context.globalState.update(CURRENT_FONT_KEY, fontName),
        context.globalState.update(RECENT_FONTS_KEY, updatedRecentFonts),
    ]);
}

async function migrateLegacyFontSelection(
    context: vscode.ExtensionContext,
    targetPath: string,
    backupPath: string,
): Promise<void> {
    if (context.globalState.get<string>(CURRENT_FONT_KEY)
        || !fs.existsSync(targetPath)
        || !fs.existsSync(backupPath)) {
        return;
    }

    const backupContent = fs.readFileSync(backupPath, 'utf-8');
    const currentContent = fs.readFileSync(targetPath, 'utf-8');
    const legacyFontName = detectPatchedMarkdownFont(backupContent, currentContent);
    if (legacyFontName) {
        await rememberFontSelection(context, legacyFontName);
    }
}

async function confirmFirstModification(context: vscode.ExtensionContext): Promise<boolean> {
    if (context.globalState.get<boolean>(MODIFICATION_NOTICE_ACCEPTED_KEY, false)) {
        return true;
    }

    const continueAction = 'Continue';
    const learnMoreAction = 'Learn More';
    const selectedAction = await vscode.window.showWarningMessage(
        'UI Font Changer modifies VS Code installation files. VS Code may report that the installation is corrupt, and VS Code updates can reset the selected font.',
        { modal: true },
        continueAction,
        learnMoreAction,
    );

    if (selectedAction === learnMoreAction) {
        await vscode.env.openExternal(vscode.Uri.parse(DOCUMENTATION_URL));
        return false;
    }

    if (selectedAction !== continueAction) {
        return false;
    }

    await context.globalState.update(MODIFICATION_NOTICE_ACCEPTED_KEY, true);
    return true;
}

async function pickFontName(context: vscode.ExtensionContext): Promise<string | undefined> {
    const installedFonts = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Finding installed fonts...',
        cancellable: false,
    }, () => getInstalledFonts());
    const currentFont = context.globalState.get<string>(CURRENT_FONT_KEY);
    const recentFonts = context.globalState.get<string[]>(RECENT_FONTS_KEY, []);

    if (installedFonts.length === 0 && !currentFont && recentFonts.length === 0) {
        // Font enumeration can fail on some machines, but manual entry should still keep the command usable.
        return promptForCustomFont(installedFonts);
    }

    const prioritizedFonts = prioritizeFontNames(installedFonts, currentFont, recentFonts);
    const recentFontKeys = new Set(recentFonts.map(fontName => fontName.toLocaleLowerCase()));

    const quickPickItems: FontQuickPickItem[] = [
        {
            label: '$(edit) Enter a custom font...',
            description: 'Type a font name manually',
            fontName: '',
        },
        ...prioritizedFonts.map(fontName => ({
            label: fontName,
            description: currentFont?.localeCompare(fontName, undefined, { sensitivity: 'accent' }) === 0
                ? 'Current UI font'
                : recentFontKeys.has(fontName.toLocaleLowerCase())
                    ? 'Recently used'
                    : undefined,
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

    return promptForCustomFont(installedFonts);
}

async function applyFont(
    context: vscode.ExtensionContext,
    targets: TargetFiles,
    backups: BackupFiles,
    namesToReplace: ReadonlyArray<string>,
    fontName: string,
): Promise<SurfaceUpdate[] | undefined> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Applying UI font: ${fontName}`,
        cancellable: false,
    }, async () => {
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
            return undefined;
        }

        applyWritesTransactionally(plannedWrites);
        await rememberFontSelection(context, fontName);
        return summarizeSurfaceUpdates(targets, plannedWrites);
    });
}

function formatSurfaceUpdateSummary(
    updates: ReadonlyArray<SurfaceUpdate>,
    completedLabel: string,
    partialLabel: string,
): string {
    const complete = updates.filter(update => update.status === 'updated').map(update => update.name);
    const partial = updates.filter(update => update.status === 'partial').map(update => update.name);
    const unavailable = updates.filter(update => update.status === 'unavailable').map(update => update.name);
    const parts: string[] = [];

    if (complete.length > 0) {
        parts.push(`${completedLabel}: ${complete.join(', ')}.`);
    }
    if (partial.length > 0) {
        parts.push(`${partialLabel}: ${partial.join(', ')}.`);
    }
    if (unavailable.length > 0) {
        parts.push(`Unavailable: ${unavailable.join(', ')}.`);
    }

    return parts.join(' ');
}

async function offerToCloseVsCode(message: string, showAsWarning: boolean = false): Promise<void> {
    const closeAction = showAsWarning
        ? await vscode.window.showWarningMessage(message, 'Close VS Code')
        : await vscode.window.showInformationMessage(message, 'Close VS Code');
    if (closeAction === 'Close VS Code') {
        await vscode.commands.executeCommand('workbench.action.quit');
    }
}

export function shouldShowWelcomeNotification(wasShown: boolean, hasExistingBackups: boolean): boolean {
    return !wasShown && !hasExistingBackups;
}

async function showWelcomeNotification(
    context: vscode.ExtensionContext,
    hasExistingBackups: boolean,
): Promise<void> {
    const wasShown = context.globalState.get<boolean>(WELCOME_NOTIFICATION_SHOWN_KEY, false);
    if (!shouldShowWelcomeNotification(wasShown, hasExistingBackups)) {
        if (!wasShown) {
            await context.globalState.update(WELCOME_NOTIFICATION_SHOWN_KEY, true);
        }
        return;
    }

    await context.globalState.update(WELCOME_NOTIFICATION_SHOWN_KEY, true);

    const chooseFontAction = 'Choose Font';
    const learnMoreAction = 'Learn More';
    const selectedAction = await vscode.window.showInformationMessage(
        'UI Font Changer is ready. Choose a font to customize the VS Code interface.',
        chooseFontAction,
        learnMoreAction,
    );

    if (selectedAction === chooseFontAction) {
        await vscode.commands.executeCommand('ui-font-changer-for-vscode.change');
    } else if (selectedAction === learnMoreAction) {
        await vscode.env.openExternal(vscode.Uri.parse(DOCUMENTATION_URL));
    }
}

export function activate(context: vscode.ExtensionContext) {

    const targets = getTargetFiles(vscode.env.appRoot);
    const backups = getBackupFiles(context);
    const namesToReplace = getDefaultFontsToReplaceForPlatform(process.platform);

    const applyAndNotify = async (fontName: string): Promise<void> => {
        if (!await confirmFirstModification(context)) {
            return;
        }

        try {
            const updates = await applyFont(context, targets, backups, namesToReplace, fontName);
            if (!updates) {
                vscode.window.showWarningMessage('No compatible VS Code UI files were found to update.');
                return;
            }

            const hasIncompleteSurface = updates.some(update => update.status !== 'updated');
            const summary = formatSurfaceUpdateSummary(updates, 'Updated', 'Partially updated');
            await offerToCloseVsCode(
                `Font changed to ${fontName}. ${summary} Quit and reopen VS Code to apply.`,
                hasIncompleteSurface,
            );
        } catch (error: any) {
            await showUserFacingError(error);
        }
    };

    const changeDisposable = vscode.commands.registerCommand('ui-font-changer-for-vscode.change', async () => {
        await migrateLegacyFontSelection(context, targets.markdownCss, backups.markdownCss);
        const fontName = await pickFontName(context);

        if (fontName) {
            await applyAndNotify(fontName);
        }
    });

    const reapplyDisposable = vscode.commands.registerCommand('ui-font-changer-for-vscode.reapply', async () => {
        await migrateLegacyFontSelection(context, targets.markdownCss, backups.markdownCss);
        const fontName = context.globalState.get<string>(CURRENT_FONT_KEY);
        if (!fontName) {
            vscode.window.showWarningMessage('No previously selected UI font was found. Choose a font first.');
            return;
        }

        await applyAndNotify(fontName);
    });

    const restoreDisposable = vscode.commands.registerCommand('ui-font-changer-for-vscode.restore', async () => {
        if (!hasRestorableBackupSet(backups)) {
            vscode.window.showWarningMessage('No compatible font backup was found for this VS Code build.');
            return;
        }

        try {
            const restoredSurfaces = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Restoring original UI fonts...',
                cancellable: false,
            }, async () => {
                const filesToRestore = [
                    { target: targets.workbenchCss, backup: backups.workbenchCss },
                    { target: targets.workbenchJs, backup: backups.workbenchJs },
                    { target: targets.sessionsCss, backup: backups.sessionsCss },
                    { target: targets.sessionsJs, backup: backups.sessionsJs },
                    { target: targets.markdownCss, backup: backups.markdownCss },
                ];

                preflightRestoreTargets(filesToRestore, backups.root);

                const plannedWrites = planRestoreWrites(filesToRestore);
                if (plannedWrites.length === 0) {
                    return undefined;
                }

                applyWritesTransactionally(plannedWrites);
                await context.globalState.update(CURRENT_FONT_KEY, undefined);
                return summarizeSurfaceUpdates(targets, plannedWrites);
            });

            if (!restoredSurfaces) {
                vscode.window.showWarningMessage('No backup files were available to restore for this VS Code build.');
                return;
            }

            const hasIncompleteSurface = restoredSurfaces.some(update => update.status !== 'updated');
            const summary = formatSurfaceUpdateSummary(restoredSurfaces, 'Restored', 'Partially restored');
            await offerToCloseVsCode(
                `Original VS Code fonts restored. ${summary} Quit and reopen VS Code to apply.`,
                hasIncompleteSurface,
            );
        } catch (error: any) {
            await showUserFacingError(error);
        }
    });

    context.subscriptions.push(changeDisposable, reapplyDisposable, restoreDisposable);
    const hasExistingBackups = getBackupContentPaths(backups).some(filePath => fs.existsSync(filePath));
    void showWelcomeNotification(context, hasExistingBackups);
}

export function deactivate() {}
