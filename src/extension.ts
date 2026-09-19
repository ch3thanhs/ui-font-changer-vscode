import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import {
    detectPatchedMarkdownFont,
    getDefaultFontsToReplaceForPlatform,
    getFontNameValidationError,
    getInstalledFonts,
    isInstalledFont,
    normalizeCustomFontName,
    prioritizeFontNames,
} from './font-utils';
import { createOperationQueue } from './operation-queue';
import * as patcher from './patcher';
import {
    type BackupFiles,
    type BackupMetadata,
    getBackupContentPaths,
    getBackupFiles,
    getCurrentBackupMetadata,
    getTargetFiles,
    type SurfaceUpdate,
    summarizeSurfaceUpdates,
    type TargetFiles,
} from './patcher';

export * from './font-utils';
export * from './operation-queue';
export * from './patcher';

const CURRENT_FONT_KEY = 'currentFont';
const RECENT_FONTS_KEY = 'recentFonts';
const MODIFICATION_NOTICE_ACCEPTED_KEY = 'modificationNoticeAccepted';
const WELCOME_NOTIFICATION_SHOWN_KEY = 'welcomeNotificationShown';
const MAX_RECENT_FONTS = 5;
const DOCUMENTATION_URL = 'https://github.com/ch3thanhs/ui-font-changer-vscode#readme';

async function showUserFacingError(error: unknown): Promise<void> {
    const message = patcher.toUserFacingErrorMessage(error);
    if (!(error instanceof patcher.FileAccessError) && !patcher.isPermissionError(error)) {
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
        || !await patcher.pathExists(targetPath)
        || !await patcher.pathExists(backupPath)) {
        return;
    }

    const backupContent = await fs.readFile(backupPath, 'utf-8');
    const currentContent = await fs.readFile(targetPath, 'utf-8');
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
    currentMetadata: BackupMetadata,
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

        await patcher.preflightPatchTargets([
            ...filesToModify,
            { target: targets.markdownCss },
        ], backups.root);
        await patcher.prepareBackupSet(backups, currentMetadata);

        const plannedWrites = await patcher.planFontPatchWrites(filesToModify, fontName, namesToReplace);
        const markdownWrite = await patcher.planMarkdownPatchWrite(
            targets.markdownCss,
            backups.markdownCss,
            fontName,
        );
        if (markdownWrite) {
            plannedWrites.push(markdownWrite);
        }

        await patcher.finalizeBackupSet(backups);

        if (plannedWrites.length === 0) {
            return undefined;
        }

        await patcher.applyWritesTransactionally(plannedWrites);
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {

    const targets = getTargetFiles(vscode.env.appRoot);
    const backups = getBackupFiles(context.globalStorageUri.fsPath);
    const currentMetadata = await getCurrentBackupMetadata(
        vscode.version,
        vscode.env.appName,
        vscode.env.appRoot,
    );
    const namesToReplace = getDefaultFontsToReplaceForPlatform(process.platform);
    const runOperation = createOperationQueue();

    const applyAndNotify = async (fontName: string): Promise<void> => {
        if (!await confirmFirstModification(context)) {
            return;
        }

        try {
            const updates = await applyFont(context, targets, backups, currentMetadata, namesToReplace, fontName);
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
        } catch (error) {
            await showUserFacingError(error);
        }
    };

    const changeDisposable = vscode.commands.registerCommand('ui-font-changer-for-vscode.change', async () => {
        await migrateLegacyFontSelection(context, targets.markdownCss, backups.markdownCss);
        const fontName = await pickFontName(context);

        if (fontName) {
            await runOperation(() => applyAndNotify(fontName));
        }
    });

    const reapplyDisposable = vscode.commands.registerCommand('ui-font-changer-for-vscode.reapply', async () => {
        await migrateLegacyFontSelection(context, targets.markdownCss, backups.markdownCss);
        const fontName = context.globalState.get<string>(CURRENT_FONT_KEY);
        if (!fontName) {
            vscode.window.showWarningMessage('No previously selected UI font was found. Choose a font first.');
            return;
        }

        await runOperation(() => applyAndNotify(fontName));
    });

    const restoreDisposable = vscode.commands.registerCommand('ui-font-changer-for-vscode.restore', () => runOperation(async () => {
        if (!await patcher.hasRestorableBackupSet(backups, currentMetadata)) {
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

                await patcher.preflightRestoreTargets(filesToRestore, backups.root);

                const plannedWrites = await patcher.planRestoreWrites(filesToRestore);
                if (plannedWrites.length === 0) {
                    return undefined;
                }

                await patcher.applyWritesTransactionally(plannedWrites);
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
        } catch (error) {
            await showUserFacingError(error);
        }
    }));

    context.subscriptions.push(changeDisposable, reapplyDisposable, restoreDisposable);
    const backupExistence = await Promise.all(getBackupContentPaths(backups).map(patcher.pathExists));
    const hasExistingBackups = backupExistence.some(Boolean);
    void showWelcomeNotification(context, hasExistingBackups);
}

export function deactivate() {}
