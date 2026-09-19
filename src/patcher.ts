import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import {
    buildMarkdownRule,
    containsTargetFontReferences,
    replaceFontInContent,
} from './font-utils';

const BACKUP_METADATA_VERSION = 3;
const WINDOWS_PLATFORM = 'win32';
const MACOS_PLATFORM = 'darwin';

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
    state?: 'creating' | 'complete';
    files?: Record<string, BackupFileMetadata>;
}

interface BackupFileMetadata {
    size: number;
    sha256: string;
}

export interface PlannedFileWrite {
    targetPath: string;
    content: string;
}

export interface SurfaceUpdate {
    name: string;
    status: 'updated' | 'partial' | 'unavailable';
}

export class FileAccessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileAccessError';
    }
}

export class FileVerificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileVerificationError';
    }
}

export function getTargetFiles(appRoot: string): TargetFiles {
    return {
        workbenchCss: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.css'),
        workbenchJs: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
        sessionsCss: path.join(appRoot, 'out', 'vs', 'sessions', 'sessions.desktop.main.css'),
        sessionsJs: path.join(appRoot, 'out', 'vs', 'sessions', 'sessions.desktop.main.js'),
        markdownCss: path.join(appRoot, 'extensions', 'markdown-language-features', 'media', 'markdown.css'),
    };
}

export function getBackupFiles(globalStoragePath: string): BackupFiles {
    const backupRoot = path.join(globalStoragePath, 'ui-font-changer-for-vscode-backups');

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

export function getBackupContentPaths(backups: BackupFiles): string[] {
    return [
        backups.workbenchCss,
        backups.workbenchJs,
        backups.sessionsCss,
        backups.sessionsJs,
        backups.markdownCss,
    ];
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

export async function getCurrentBackupMetadata(
    vscodeVersion: string,
    appName: string,
    appRoot: string,
): Promise<BackupMetadata> {
    return {
        version: BACKUP_METADATA_VERSION,
        vscodeVersion,
        appName,
        appRoot,
        buildId: await getVsCodeBuildId(appRoot),
        state: 'creating',
        files: {},
    };
}

async function getVsCodeBuildId(appRoot: string): Promise<string> {
    try {
        const productJson = JSON.parse(await fs.readFile(path.join(appRoot, 'product.json'), 'utf-8')) as {
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

export function isBackupMetadataCurrent(metadata: BackupMetadata, currentMetadata: BackupMetadata): boolean {
    return metadata.version === currentMetadata.version
        && metadata.vscodeVersion === currentMetadata.vscodeVersion
        && metadata.appName === currentMetadata.appName
        && metadata.appRoot === currentMetadata.appRoot
        && metadata.buildId === currentMetadata.buildId;
}

function isLegacyBackupMetadataCompatible(metadata: BackupMetadata, currentMetadata: BackupMetadata): boolean {
    if (metadata.version === 1) {
        return metadata.vscodeVersion === currentMetadata.vscodeVersion
            && metadata.appName === currentMetadata.appName;
    }

    return metadata.version === 2
        && metadata.vscodeVersion === currentMetadata.vscodeVersion
        && metadata.appName === currentMetadata.appName
        && metadata.appRoot === currentMetadata.appRoot
        && metadata.buildId === currentMetadata.buildId;
}

export async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function readBackupMetadata(
    backups: Pick<BackupFiles, 'metadata'>,
): Promise<BackupMetadata | undefined> {
    if (!await pathExists(backups.metadata)) {
        return undefined;
    }

    try {
        const content = await fs.readFile(backups.metadata, 'utf-8');
        return JSON.parse(content) as BackupMetadata;
    } catch {
        return undefined;
    }
}

async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
    await writeTextAtomically(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function getBackupFileMetadata(filePath: string): Promise<BackupFileMetadata> {
    const content = await fs.readFile(filePath);
    return {
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
    };
}

async function isBackupFileIntact(filePath: string, expected: BackupFileMetadata): Promise<boolean> {
    if (!await pathExists(filePath)) {
        return false;
    }

    const actual = await getBackupFileMetadata(filePath);
    return actual.size === expected.size && actual.sha256 === expected.sha256;
}

async function isBackupManifestIntact(backups: BackupFiles, metadata: BackupMetadata): Promise<boolean> {
    if (metadata.state !== 'complete' || !metadata.files) {
        return false;
    }

    const results = await Promise.all(Object.entries(metadata.files).map(async ([fileName, expected]) =>
        path.basename(fileName) === fileName
        && await isBackupFileIntact(path.join(backups.root, fileName), expected),
    ));
    return results.every(Boolean);
}

function createBackupIntegrityError(): FileVerificationError {
    return new FileVerificationError(
        'UI Font Changer for VS Code found an incomplete or modified backup set. Repair or update VS Code before applying another font.',
    );
}

async function verifyFileContent(filePath: string, expectedContent: string): Promise<void> {
    const writtenContent = await fs.readFile(filePath, 'utf-8');
    if (writtenContent !== expectedContent) {
        throw new FileVerificationError(
            `UI Font Changer for VS Code could not verify the updated contents of ${describePathForUser(filePath)}.`,
        );
    }
}

async function writeTextAtomically(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.ui-font-changer-for-vscode.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    try {
        await fs.writeFile(tempPath, content, 'utf-8');
        await verifyFileContent(tempPath, content);
        await fs.rename(tempPath, filePath);
        await verifyFileContent(filePath, content);
    } catch (error) {
        await fs.rm(tempPath, { force: true });
        throw error;
    }
}

async function resetBackupSet(backups: BackupFiles): Promise<void> {
    await fs.rm(backups.root, { recursive: true, force: true });
}

function describePathForUser(filePath: string): string {
    return path.basename(filePath);
}

export function isPermissionError(error: unknown): boolean {
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

async function ensureDirectoryWritable(dirPath: string, purpose: string): Promise<void> {
    let probeHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const probePath = path.join(dirPath, `.ui-font-changer-for-vscode-probe-${process.pid}-${Date.now()}`);

    try {
        await fs.mkdir(dirPath, { recursive: true });
        probeHandle = await fs.open(probePath, 'wx');
    } catch (error) {
        if (isPermissionError(error)) {
            throw new FileAccessError(
                `UI Font Changer for VS Code could not write to ${purpose}. ${getElevationHint()}`,
            );
        }
        throw error;
    } finally {
        if (probeHandle) {
            await probeHandle.close();
            try {
                await fs.unlink(probePath);
            } catch {
                // Leftover probe files are harmless; never fail the command over cleanup.
            }
        }
    }
}

async function ensureFileReadableWritable(filePath: string, purpose: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;

    try {
        handle = await fs.open(filePath, 'r+');
    } catch (error) {
        if (isPermissionError(error)) {
            throw new FileAccessError(
                `UI Font Changer for VS Code could not modify ${purpose} (${describePathForUser(filePath)}). ${getElevationHint()}`,
            );
        }
        throw error;
    } finally {
        if (handle) {
            await handle.close();
        }
    }
}

export async function preflightPatchTargets(
    targets: Array<{ target: string }>,
    backupRoot: string,
): Promise<void> {
    await ensureDirectoryWritable(backupRoot, 'backup storage');

    for (const { target } of targets) {
        if (!await pathExists(target)) {
            continue;
        }

        await ensureFileReadableWritable(target, 'a VS Code UI file');
        await ensureDirectoryWritable(path.dirname(target), `the directory containing ${describePathForUser(target)}`);
    }
}

export async function preflightRestoreTargets(
    targets: Array<{ target: string; backup: string }>,
    backupRoot: string,
): Promise<void> {
    await ensureDirectoryWritable(backupRoot, 'backup storage');

    for (const { target, backup } of targets) {
        if (!await pathExists(target) || !await pathExists(backup)) {
            continue;
        }

        await ensureFileReadableWritable(target, 'a VS Code UI file');
        await ensureFileReadableWritable(backup, 'a backup file');
        await ensureDirectoryWritable(path.dirname(target), `the directory containing ${describePathForUser(target)}`);
    }
}

export function toUserFacingErrorMessage(error: unknown): string {
    if (error instanceof FileVerificationError || error instanceof FileAccessError) {
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

export async function prepareBackupSet(
    backups: BackupFiles,
    currentMetadata: BackupMetadata,
): Promise<void> {
    const existingMetadata = await readBackupMetadata(backups);
    const backupExistence = await Promise.all(getBackupContentPaths(backups).map(pathExists));
    const hasExistingBackups = backupExistence.some(Boolean);
    const hasMetadataFile = await pathExists(backups.metadata);

    if (existingMetadata && isBackupMetadataCurrent(existingMetadata, currentMetadata)) {
        if (existingMetadata.state === 'complete') {
            if (!await isBackupManifestIntact(backups, existingMetadata)) {
                throw createBackupIntegrityError();
            }
            return;
        }

        if (existingMetadata.state !== 'creating') {
            throw createBackupIntegrityError();
        }

        await resetBackupSet(backups);
    } else if (existingMetadata && isLegacyBackupMetadataCompatible(existingMetadata, currentMetadata)) {
        const existingBackupPaths = getBackupContentPaths(backups)
            .filter((_, index) => backupExistence[index]);
        const files = Object.fromEntries(await Promise.all(existingBackupPaths.map(async filePath =>
            [path.basename(filePath), await getBackupFileMetadata(filePath)] as const,
        )));
        await fs.mkdir(backups.root, { recursive: true });
        await writeJsonAtomically(backups.metadata, {
            ...currentMetadata,
            state: 'complete',
            files,
        });
        return;
    } else if (existingMetadata) {
        await resetBackupSet(backups);
    } else if (hasExistingBackups || hasMetadataFile) {
        throw createBackupIntegrityError();
    }

    await fs.mkdir(backups.root, { recursive: true });
    await writeJsonAtomically(backups.metadata, {
        ...currentMetadata,
        state: 'creating',
        files: {},
    });
}

export async function finalizeBackupSet(backups: BackupFiles): Promise<void> {
    const metadata = await readBackupMetadata(backups);
    if (!metadata) {
        throw createBackupIntegrityError();
    }

    if (metadata.state === 'complete') {
        if (!await isBackupManifestIntact(backups, metadata)) {
            throw createBackupIntegrityError();
        }
        return;
    }

    if (metadata.state !== 'creating'
        || !metadata.files
        || !await isBackupManifestIntact(backups, { ...metadata, state: 'complete' })) {
        throw createBackupIntegrityError();
    }

    await writeJsonAtomically(backups.metadata, { ...metadata, state: 'complete' });
}

function buildPatchedFontFileContent(
    content: string,
    fontName: string,
    filePath: string,
    namesToReplace: ReadonlyArray<string>,
): string {
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

export async function applyWritesTransactionally(
    writes: PlannedFileWrite[],
    writeText: (filePath: string, content: string) => Promise<void> = writeTextAtomically,
): Promise<void> {
    const originals = new Map<string, string>();
    await Promise.all(writes.map(async write => {
        originals.set(write.targetPath, await fs.readFile(write.targetPath, 'utf-8'));
    }));

    const writtenPaths: string[] = [];
    try {
        for (const write of writes) {
            writtenPaths.push(write.targetPath);
            await writeText(write.targetPath, write.content);
        }
    } catch (error) {
        const rollbackFailures: string[] = [];

        for (const targetPath of writtenPaths.reverse()) {
            const originalContent = originals.get(targetPath);
            if (originalContent === undefined) {
                continue;
            }

            try {
                await writeTextAtomically(targetPath, originalContent);
            } catch (rollbackError) {
                rollbackFailures.push(`${describePathForUser(targetPath)}: ${toUserFacingErrorMessage(rollbackError)}`);
            }
        }

        if (rollbackFailures.length > 0) {
            throw new FileVerificationError(
                `UI Font Changer for VS Code failed to update the VS Code UI files and could not fully roll back changes. ${rollbackFailures.join(' | ')}`,
            );
        }

        throw error;
    }
}

export async function planFontPatchWrites(
    filesToModify: Array<{ target: string; backup: string }>,
    fontName: string,
    namesToReplace: ReadonlyArray<string>,
): Promise<PlannedFileWrite[]> {
    const plannedWrites: PlannedFileWrite[] = [];

    for (const { target, backup } of filesToModify) {
        if (!await pathExists(target)) {
            continue;
        }

        await ensureBackup(target, backup);
        const backupContent = await fs.readFile(backup, 'utf-8');
        plannedWrites.push({
            targetPath: target,
            content: buildPatchedFontFileContent(backupContent, fontName, target, namesToReplace),
        });
    }

    return plannedWrites;
}

export async function planMarkdownPatchWrite(
    targetPath: string,
    backupPath: string,
    fontName: string,
): Promise<PlannedFileWrite | undefined> {
    if (!await pathExists(targetPath)) {
        return undefined;
    }

    await ensureBackup(targetPath, backupPath);
    const backupContent = await fs.readFile(backupPath, 'utf-8');
    return {
        targetPath,
        content: `${backupContent}\n${buildMarkdownRule(fontName)}`,
    };
}

export async function planRestoreWrites(
    filesToRestore: Array<{ target: string; backup: string }>,
): Promise<PlannedFileWrite[]> {
    const plannedWrites: PlannedFileWrite[] = [];

    for (const { target, backup } of filesToRestore) {
        if (!await pathExists(target) || !await pathExists(backup)) {
            continue;
        }

        plannedWrites.push({
            targetPath: target,
            content: await fs.readFile(backup, 'utf-8'),
        });
    }

    return plannedWrites;
}

export async function hasRestorableBackupSet(
    backups: BackupFiles,
    currentMetadata: BackupMetadata,
): Promise<boolean> {
    const metadata = await readBackupMetadata(backups);
    if (!metadata
        || (!isBackupMetadataCurrent(metadata, currentMetadata)
            && !isLegacyBackupMetadataCompatible(metadata, currentMetadata))) {
        return false;
    }

    if (isBackupMetadataCurrent(metadata, currentMetadata)) {
        return Object.keys(metadata.files ?? {}).length > 0 && await isBackupManifestIntact(backups, metadata);
    }

    const backupExistence = await Promise.all(getBackupContentPaths(backups).map(pathExists));
    return backupExistence.some(Boolean);
}

async function ensureBackup(contentPath: string, backupPath: string): Promise<void> {
    const metadataPath = path.join(path.dirname(backupPath), 'metadata.json');
    const metadata = await readBackupMetadata({ metadata: metadataPath });
    if (!metadata || !metadata.files) {
        throw createBackupIntegrityError();
    }

    const fileName = path.basename(backupPath);
    const expected = metadata.files[fileName];
    if (metadata.state === 'complete') {
        if (!expected || !await isBackupFileIntact(backupPath, expected)) {
            throw createBackupIntegrityError();
        }
        return;
    }

    if (metadata.state !== 'creating') {
        throw createBackupIntegrityError();
    }

    if (expected) {
        if (!await isBackupFileIntact(backupPath, expected)) {
            throw createBackupIntegrityError();
        }
        return;
    }

    if (await pathExists(backupPath)) {
        throw createBackupIntegrityError();
    }

    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(contentPath, backupPath);
    await writeJsonAtomically(metadataPath, {
        ...metadata,
        files: {
            ...metadata.files,
            [fileName]: await getBackupFileMetadata(backupPath),
        },
    });
}