import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { shouldShowWelcomeNotification } from '../extension';
import {
    containsTargetFontReferences,
    DEFAULT_FONTS_TO_REPLACE,
    buildMarkdownRule,
    detectPatchedMarkdownFont,
    FONT_ENUMERATION_TIMEOUT_MS,
    getDefaultFontsToReplaceForPlatform,
    getFontNameValidationError,
    getInstalledFonts,
    isInstalledFont,
    LINUX_FONTS_TO_REPLACE,
    MACOS_FONTS_TO_REPLACE,
    normalizeFontFamilyName,
    normalizeCustomFontName,
    parseInstalledFontList,
    prioritizeFontNames,
    replaceFontInContent,
} from '../font-utils';
import { createOperationQueue } from '../operation-queue';
import {
    applyWritesTransactionally,
    type BackupFiles,
    type BackupMetadata,
    finalizeBackupSet,
    getElevationHint,
    getTargetFiles,
    hasRestorableBackupSet,
    isBackupMetadataCurrent,
    planFontPatchWrites,
    planMarkdownPatchWrite,
    planRestoreWrites,
    prepareBackupSet,
    summarizeSurfaceUpdates,
} from '../patcher';

suite('replaceFontInContent', () => {
    test('replaces all three default Segoe variants', () => {
        const input = 'font-family: "Segoe WPC", "Segoe UI", Segoe, sans-serif;';
        const out = replaceFontInContent(input, 'Inter');
        assert.strictEqual(out, 'font-family: "Inter", "Inter", Inter, sans-serif;');
    });

    test('replaces every occurrence (global flag)', () => {
        const input = 'Segoe UI, Segoe UI, Segoe UI';
        const out = replaceFontInContent(input, 'Inter');
        assert.strictEqual(out, 'Inter, Inter, Inter');
    });

    test('"Segoe UI" is replaced before bare "Segoe" (no partial collisions)', () => {
        // If 'Segoe' were processed first, 'Segoe UI' would become 'Inter UI'.
        const input = 'font-family: Segoe UI, Segoe;';
        const out = replaceFontInContent(input, 'Inter');
        assert.strictEqual(out, 'font-family: Inter, Inter;');
    });

    test('does not replace target names inside longer font family names', () => {
        const input = '"Segoe UI Variable", "Segoe UI Emoji", "Segoe Fluent Icons"';
        const out = replaceFontInContent(input, 'Inter');

        assert.strictEqual(out, input);
    });

    test('replaces exact family entries beside longer related family names', () => {
        const input = '"Segoe UI Variable", "Segoe UI", Segoe, sans-serif';
        const out = replaceFontInContent(input, 'Inter');

        assert.strictEqual(out, '"Segoe UI Variable", "Inter", Inter, sans-serif');
    });

    test('returns content unchanged when no target font is present', () => {
        const input = 'font-family: "Arial", sans-serif;';
        const out = replaceFontInContent(input, 'Inter');
        assert.strictEqual(out, input);
    });

    test('handles empty content', () => {
        assert.strictEqual(replaceFontInContent('', 'Inter'), '');
    });

    test('accepts a font name containing spaces', () => {
        const input = '"Segoe UI"';
        const out = replaceFontInContent(input, 'JetBrains Mono');
        assert.strictEqual(out, '"JetBrains Mono"');
    });

    test('quotes a multi-word font name when the source text is unquoted', () => {
        const input = 'Segoe UI, sans-serif';
        const out = replaceFontInContent(input, 'JetBrains Mono');
        assert.strictEqual(out, "'JetBrains Mono', sans-serif");
    });

    test('respects custom namesToReplace list', () => {
        const input = 'Arial, Helvetica, sans-serif';
        const out = replaceFontInContent(input, 'Inter', ['Arial', 'Helvetica']);
        assert.strictEqual(out, 'Inter, Inter, sans-serif');
    });

    test('escapes regex metacharacters in names being replaced', () => {
        // If we ever feed in a font name with regex characters, it shouldn't blow up.
        const input = 'font-family: foo.bar, baz;';
        const out = replaceFontInContent(input, 'X', ['foo.bar']);
        assert.strictEqual(out, 'font-family: X, baz;');
    });

    test('escapes quotes and backslashes inside quoted replacements', () => {
        assert.strictEqual(replaceFontInContent('"Segoe UI"', 'A"B\\C'), '"A\\"B\\\\C"');
        assert.strictEqual(replaceFontInContent("'Segoe UI'", "O'Brien"), "'O\\'Brien'");
    });

    test('rejects control characters before changing content', () => {
        assert.throws(() => replaceFontInContent('Segoe UI', 'Bad\nFont'), /control characters/);
    });

    test('does not process replacement text that contains another target token', () => {
        const input = '"Segoe UI", Segoe';
        const out = replaceFontInContent(input, 'Segoe UI Variable');

        assert.strictEqual(out, '"Segoe UI Variable", \'Segoe UI Variable\'');
    });

    test('uses longest-first matching regardless of custom target order', () => {
        const out = replaceFontInContent('font-family: Segoe UI, Segoe;', 'Inter', ['Segoe', 'Segoe UI']);

        assert.strictEqual(out, 'font-family: Inter, Inter;');
    });

    test('returns content unchanged when the target list is empty', () => {
        assert.strictEqual(replaceFontInContent('Segoe UI', 'Inter', []), 'Segoe UI');
    });
});

suite('DEFAULT_FONTS_TO_REPLACE', () => {
    test('exposes the expected three Segoe variants in priority order', () => {
        assert.deepStrictEqual([...DEFAULT_FONTS_TO_REPLACE], ['Segoe UI', 'Segoe WPC', 'Segoe']);
    });

    test('lists more-specific names before less-specific ones', () => {
        const segoeIdx = DEFAULT_FONTS_TO_REPLACE.indexOf('Segoe');
        const segoeUiIdx = DEFAULT_FONTS_TO_REPLACE.indexOf('Segoe UI');
        assert.ok(segoeUiIdx < segoeIdx, '"Segoe UI" must come before bare "Segoe"');
    });

    test('detects when expected font tokens are present', () => {
        assert.strictEqual(containsTargetFontReferences('font-family: Segoe UI, sans-serif;'), true);
        assert.strictEqual(containsTargetFontReferences('font-family: Arial, sans-serif;'), false);
    });

    test('selects platform-specific token defaults', () => {
        assert.deepStrictEqual(getDefaultFontsToReplaceForPlatform('win32'), [...DEFAULT_FONTS_TO_REPLACE]);
        assert.deepStrictEqual(getDefaultFontsToReplaceForPlatform('darwin'), [...MACOS_FONTS_TO_REPLACE]);
        assert.deepStrictEqual(getDefaultFontsToReplaceForPlatform('linux'), [...LINUX_FONTS_TO_REPLACE]);
    });
});

suite('buildMarkdownRule', () => {
    test('returns a CSS rule targeting html, body with !important', () => {
        const rule = buildMarkdownRule('Inter');
        assert.ok(rule.includes('html, body'), 'rule should target html, body');
        assert.ok(rule.includes('font-family: "Inter"'), 'rule should contain quoted font name');
        assert.ok(rule.includes('!important'), 'rule should use !important');
    });

    test('quotes font names that contain spaces', () => {
        const rule = buildMarkdownRule('JetBrains Mono');
        assert.ok(rule.includes('"JetBrains Mono"'));
    });

    test('produces deterministic output for the same input', () => {
        assert.strictEqual(buildMarkdownRule('Inter'), buildMarkdownRule('Inter'));
    });

    test('escapes quotes and backslashes in the Markdown CSS rule', () => {
        const rule = buildMarkdownRule('A"B\\C');
        assert.ok(rule.includes('font-family: "A\\"B\\\\C"'));
    });

    test('detects a font appended to a pristine Markdown backup', () => {
        const backupContent = 'body { color: var(--vscode-foreground); }';
        const currentContent = `${backupContent}\n${buildMarkdownRule('JetBrains Mono')}`;

        assert.strictEqual(detectPatchedMarkdownFont(backupContent, currentContent), 'JetBrains Mono');
    });

    test('does not infer a font from unrelated or unmodified content', () => {
        const backupContent = 'body { color: var(--vscode-foreground); }';

        assert.strictEqual(detectPatchedMarkdownFont(backupContent, backupContent), undefined);
        assert.strictEqual(detectPatchedMarkdownFont(backupContent, 'unrelated content'), undefined);
    });

    test('round-trips escaped font names from a patched Markdown file', () => {
        const backupContent = 'body { color: var(--vscode-foreground); }';
        const fontName = 'A"B\\C';
        const currentContent = `${backupContent}\n${buildMarkdownRule(fontName)}`;

        assert.strictEqual(detectPatchedMarkdownFont(backupContent, currentContent), fontName);
    });
});

suite('transactional writes', () => {
    let tempRoot: string;

    setup(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-font-changer-test-'));
    });

    teardown(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('restores every target when a writer fails after modifying the current file', async () => {
        const firstPath = path.join(tempRoot, 'first.css');
        const secondPath = path.join(tempRoot, 'second.css');
        fs.writeFileSync(firstPath, 'first original');
        fs.writeFileSync(secondPath, 'second original');

        await assert.rejects(applyWritesTransactionally([
            { targetPath: firstPath, content: 'first updated' },
            { targetPath: secondPath, content: 'second updated' },
        ], async (filePath, content) => {
            fs.writeFileSync(filePath, content);
            if (filePath === secondPath) {
                throw new Error('simulated write failure');
            }
        }), /simulated write failure/);

        assert.strictEqual(fs.readFileSync(firstPath, 'utf-8'), 'first original');
        assert.strictEqual(fs.readFileSync(secondPath, 'utf-8'), 'second original');
    });
});

suite('operation queue', () => {
    test('runs operations sequentially in invocation order', async () => {
        const runOperation = createOperationQueue();
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstCanFinish = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });

        const first = runOperation(async () => {
            events.push('first started');
            await firstCanFinish;
            events.push('first finished');
        });
        const second = runOperation(async () => {
            events.push('second started');
        });

        await Promise.resolve();
        assert.deepStrictEqual(events, ['first started']);
        releaseFirst();
        await Promise.all([first, second]);
        assert.deepStrictEqual(events, ['first started', 'first finished', 'second started']);
    });

    test('continues with later operations after a failure', async () => {
        const runOperation = createOperationQueue();
        const failed = runOperation(async () => {
            throw new Error('simulated failure');
        });
        const recovered = runOperation(async () => 'recovered');

        await assert.rejects(failed, /simulated failure/);
        assert.strictEqual(await recovered, 'recovered');
    });
});

suite('backup and restore filesystem workflow', () => {
    let tempRoot: string;
    let backups: BackupFiles;
    const currentMetadata: BackupMetadata = {
        version: 3,
        vscodeVersion: '1.2.3',
        appName: 'Visual Studio Code',
        appRoot: '/applications/code/resources/app',
        buildId: 'abc123',
    };

    setup(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-font-changer-workflow-test-'));
        const backupRoot = path.join(tempRoot, 'backups');
        backups = {
            root: backupRoot,
            metadata: path.join(backupRoot, 'metadata.json'),
            workbenchCss: path.join(backupRoot, 'workbench.css.bak'),
            workbenchJs: path.join(backupRoot, 'workbench.js.bak'),
            sessionsCss: path.join(backupRoot, 'sessions.css.bak'),
            sessionsJs: path.join(backupRoot, 'sessions.js.bak'),
            markdownCss: path.join(backupRoot, 'markdown.css.bak'),
        };
    });

    teardown(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('patches all surfaces repeatedly and restores their exact original contents', async () => {
        const liveRoot = path.join(tempRoot, 'live');
        const markdownPath = path.join(tempRoot, 'live', 'markdown.css');
        const markdownOriginal = 'body { color: var(--vscode-foreground); }';
        const fontFiles = [
            {
                target: path.join(liveRoot, 'workbench.css'),
                backup: backups.workbenchCss,
                original: 'workbench-css { font-family: "Segoe UI", sans-serif; }',
            },
            {
                target: path.join(liveRoot, 'workbench.js'),
                backup: backups.workbenchJs,
                original: 'const workbenchFont = "Segoe UI";',
            },
            {
                target: path.join(liveRoot, 'sessions.css'),
                backup: backups.sessionsCss,
                original: 'sessions-css { font-family: "Segoe UI", sans-serif; }',
            },
            {
                target: path.join(liveRoot, 'sessions.js'),
                backup: backups.sessionsJs,
                original: 'const sessionsFont = "Segoe UI";',
            },
        ];
        fs.mkdirSync(liveRoot, { recursive: true });
        fontFiles.forEach(file => fs.writeFileSync(file.target, file.original));
        fs.writeFileSync(markdownPath, markdownOriginal);

        await prepareBackupSet(backups, currentMetadata);
        const patchWrites = await planFontPatchWrites(fontFiles, 'JetBrains Mono', DEFAULT_FONTS_TO_REPLACE);
        const markdownWrite = await planMarkdownPatchWrite(markdownPath, backups.markdownCss, 'JetBrains Mono');
        assert.ok(markdownWrite);
        patchWrites.push(markdownWrite);
        await finalizeBackupSet(backups);
        await applyWritesTransactionally(patchWrites);

        fontFiles.forEach(file => {
            assert.strictEqual(fs.readFileSync(file.backup, 'utf-8'), file.original);
            assert.ok(fs.readFileSync(file.target, 'utf-8').includes('"JetBrains Mono"'));
        });
        assert.strictEqual(fs.readFileSync(backups.markdownCss, 'utf-8'), markdownOriginal);
        assert.ok(fs.readFileSync(markdownPath, 'utf-8').includes(buildMarkdownRule('JetBrains Mono')));

        await prepareBackupSet(backups, currentMetadata);
        const secondPatchWrites = await planFontPatchWrites(fontFiles, 'Fira Sans', DEFAULT_FONTS_TO_REPLACE);
        const secondMarkdownWrite = await planMarkdownPatchWrite(markdownPath, backups.markdownCss, 'Fira Sans');
        assert.ok(secondMarkdownWrite);
        secondPatchWrites.push(secondMarkdownWrite);
        await finalizeBackupSet(backups);
        await applyWritesTransactionally(secondPatchWrites);

        fontFiles.forEach(file => {
            assert.strictEqual(fs.readFileSync(file.backup, 'utf-8'), file.original);
            assert.ok(fs.readFileSync(file.target, 'utf-8').includes('"Fira Sans"'));
        });
        assert.ok(fs.readFileSync(markdownPath, 'utf-8').includes(buildMarkdownRule('Fira Sans')));

        const restoreWrites = await planRestoreWrites([
            ...fontFiles,
            { target: markdownPath, backup: backups.markdownCss },
        ]);
        await applyWritesTransactionally(restoreWrites);

        fontFiles.forEach(file => {
            assert.strictEqual(fs.readFileSync(file.target, 'utf-8'), file.original);
        });
        assert.strictEqual(fs.readFileSync(markdownPath, 'utf-8'), markdownOriginal);
    });

    test('does not recreate a missing backup from patched live content', async () => {
        const firstPath = path.join(tempRoot, 'live', 'first.css');
        const secondPath = path.join(tempRoot, 'live', 'second.css');
        fs.mkdirSync(path.dirname(firstPath), { recursive: true });
        fs.writeFileSync(firstPath, 'body { font-family: "Segoe UI"; }');
        fs.writeFileSync(secondPath, 'body { font-family: "Segoe UI"; }');

        await prepareBackupSet(backups, currentMetadata);
        const initialWrites = await planFontPatchWrites([
            { target: firstPath, backup: backups.workbenchCss },
            { target: secondPath, backup: backups.workbenchJs },
        ], 'Inter', DEFAULT_FONTS_TO_REPLACE);
        await finalizeBackupSet(backups);
        await applyWritesTransactionally(initialWrites);
        fs.rmSync(backups.workbenchJs);

        await assert.rejects(prepareBackupSet(backups, currentMetadata), /backup/i);
        assert.strictEqual(fs.existsSync(backups.workbenchJs), false);
    });

    test('rejects a backup whose content no longer matches its manifest hash', async () => {
        const targetPath = path.join(tempRoot, 'live', 'workbench.css');
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, 'body { font-family: "Segoe UI"; }');

        await prepareBackupSet(backups, currentMetadata);
        await planFontPatchWrites([
            { target: targetPath, backup: backups.workbenchCss },
        ], 'Inter', DEFAULT_FONTS_TO_REPLACE);
        await finalizeBackupSet(backups);
        fs.writeFileSync(backups.workbenchCss, 'corrupted backup');

        await assert.rejects(prepareBackupSet(backups, currentMetadata), /backup/i);
        assert.strictEqual(await hasRestorableBackupSet(backups, currentMetadata), false);
    });

    test('removes backups belonging to another VS Code build', async () => {
        fs.mkdirSync(backups.root, { recursive: true });
        fs.writeFileSync(backups.metadata, JSON.stringify({ ...currentMetadata, buildId: 'old-build' }));
        fs.writeFileSync(backups.workbenchCss, 'stale backup');

        await prepareBackupSet(backups, currentMetadata);

        assert.strictEqual(fs.existsSync(backups.workbenchCss), false);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(backups.metadata, 'utf-8')), {
            ...currentMetadata,
            state: 'creating',
            files: {},
        });
    });

    test('migrates matching version 1 metadata without deleting existing backups', async () => {
        fs.mkdirSync(backups.root, { recursive: true });
        fs.writeFileSync(backups.metadata, JSON.stringify({
            version: 1,
            vscodeVersion: currentMetadata.vscodeVersion,
            appName: currentMetadata.appName,
        }));
        fs.writeFileSync(backups.workbenchCss, 'original version 1 backup');

        await prepareBackupSet(backups, currentMetadata);

        assert.strictEqual(fs.readFileSync(backups.workbenchCss, 'utf-8'), 'original version 1 backup');
        const migratedMetadata = JSON.parse(fs.readFileSync(backups.metadata, 'utf-8')) as BackupMetadata;
        assert.strictEqual(isBackupMetadataCurrent(migratedMetadata, currentMetadata), true);
        assert.strictEqual(migratedMetadata.state, 'complete');
        assert.ok(migratedMetadata.files?.[path.basename(backups.workbenchCss)]);
    });

    test('migrates version 2 backups without filling missing entries from live files', async () => {
        const existingTarget = path.join(tempRoot, 'live', 'workbench.css');
        const missingBackupTarget = path.join(tempRoot, 'live', 'workbench.js');
        fs.mkdirSync(path.dirname(existingTarget), { recursive: true });
        fs.writeFileSync(existingTarget, 'body { font-family: "Inter"; }');
        fs.writeFileSync(missingBackupTarget, 'const font = "Inter";');
        fs.mkdirSync(backups.root, { recursive: true });
        fs.writeFileSync(backups.metadata, JSON.stringify({
            ...currentMetadata,
            version: 2,
        }));
        fs.writeFileSync(backups.workbenchCss, 'body { font-family: "Segoe UI"; }');

        await prepareBackupSet(backups, currentMetadata);

        await assert.rejects(planFontPatchWrites([
            { target: existingTarget, backup: backups.workbenchCss },
            { target: missingBackupTarget, backup: backups.workbenchJs },
        ], 'JetBrains Mono', DEFAULT_FONTS_TO_REPLACE), /backup/i);
        assert.strictEqual(fs.existsSync(backups.workbenchJs), false);
    });

    test('allows restore directly from a compatible version 1 backup', async () => {
        fs.mkdirSync(backups.root, { recursive: true });
        fs.writeFileSync(backups.metadata, JSON.stringify({
            version: 1,
            vscodeVersion: currentMetadata.vscodeVersion,
            appName: currentMetadata.appName,
        }));
        fs.writeFileSync(backups.workbenchCss, 'original version 1 backup');

        assert.strictEqual(await hasRestorableBackupSet(backups, currentMetadata), true);
        assert.strictEqual(
            await hasRestorableBackupSet(backups, { ...currentMetadata, vscodeVersion: '1.2.4' }),
            false,
        );
    });
});

suite('welcome notification', () => {
    test('shows only for a new install that has not seen it', () => {
        assert.strictEqual(shouldShowWelcomeNotification(false, false), true);
        assert.strictEqual(shouldShowWelcomeNotification(true, false), false);
        assert.strictEqual(shouldShowWelcomeNotification(false, true), false);
    });
});

suite('getTargetFiles', () => {
    const appRoot = path.join('C:', 'fake', 'vscode', 'resources', 'app');

    test('returns paths for all five target files', () => {
        const targets = getTargetFiles(appRoot);
        const keys = Object.keys(targets).sort();
        assert.deepStrictEqual(keys, [
            'markdownCss',
            'sessionsCss',
            'sessionsJs',
            'workbenchCss',
            'workbenchJs',
        ]);
    });

    test('workbench paths point into out/vs/workbench/', () => {
        const targets = getTargetFiles(appRoot);
        assert.ok(targets.workbenchCss.endsWith(path.join('out', 'vs', 'workbench', 'workbench.desktop.main.css')));
        assert.ok(targets.workbenchJs.endsWith(path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js')));
    });

    test('sessions (Agents) paths point into out/vs/sessions/', () => {
        const targets = getTargetFiles(appRoot);
        assert.ok(targets.sessionsCss.endsWith(path.join('out', 'vs', 'sessions', 'sessions.desktop.main.css')));
        assert.ok(targets.sessionsJs.endsWith(path.join('out', 'vs', 'sessions', 'sessions.desktop.main.js')));
    });

    test('markdown CSS path points into the markdown-language-features extension', () => {
        const targets = getTargetFiles(appRoot);
        assert.ok(targets.markdownCss.endsWith(
            path.join('extensions', 'markdown-language-features', 'media', 'markdown.css'),
        ));
    });

    test('all target paths are absolute under the supplied appRoot', () => {
        const targets = getTargetFiles(appRoot);
        for (const [name, p] of Object.entries(targets)) {
            assert.ok(p.startsWith(appRoot), `${name} should start with appRoot, got ${p}`);
        }
    });
});

suite('surface update summaries', () => {
    const targets = getTargetFiles(path.join('C:', 'fake', 'vscode', 'resources', 'app'));

    test('reports all surfaces as updated when every target is written', () => {
        const writes = Object.values(targets).map(targetPath => ({ targetPath }));

        assert.deepStrictEqual(summarizeSurfaceUpdates(targets, writes), [
            { name: 'Workbench UI', status: 'updated' },
            { name: 'Agent windows', status: 'updated' },
            { name: 'Markdown Preview', status: 'updated' },
        ]);
    });

    test('distinguishes partial and unavailable surfaces', () => {
        const writes = [
            { targetPath: targets.workbenchCss },
            { targetPath: targets.markdownCss },
        ];

        assert.deepStrictEqual(summarizeSurfaceUpdates(targets, writes), [
            { name: 'Workbench UI', status: 'partial' },
            { name: 'Agent windows', status: 'unavailable' },
            { name: 'Markdown Preview', status: 'updated' },
        ]);
    });
});

suite('installed font parsing', () => {
    test('normalizes registry-style font names', () => {
        assert.strictEqual(normalizeFontFamilyName('Inter (TrueType)'), 'Inter');
        assert.strictEqual(normalizeFontFamilyName('"JetBrains Mono"'), 'JetBrains Mono');
    });

    test('parses and deduplicates registry and fc-list style output', () => {
        const raw = [
            'Inter (TrueType)',
            'JetBrains Mono,JetBrains Mono Medium:style=Regular',
            'Inter (TrueType)',
            '"Fira Sans"',
        ].join('\n');

        assert.deepStrictEqual(parseInstalledFontList(raw), [
            'Fira Sans',
            'Inter',
            'JetBrains Mono',
            'JetBrains Mono Medium',
        ]);
    });

    test('normalizes manually entered font names', () => {
        assert.strictEqual(normalizeCustomFontName('  "JetBrains Mono"  '), 'JetBrains Mono');
        assert.strictEqual(normalizeCustomFontName('   '), '');
    });

    test('rejects empty and control-character font names', () => {
        assert.strictEqual(getFontNameValidationError('   '), 'Enter a font name.');
        assert.strictEqual(
            getFontNameValidationError('Bad\nFont'),
            'Font names cannot contain control characters.',
        );
        assert.strictEqual(getFontNameValidationError('JetBrains Mono'), undefined);
    });

    test('matches installed fonts without case sensitivity', () => {
        assert.strictEqual(isInstalledFont('inter', ['Arial', 'Inter']), true);
        assert.strictEqual(isInstalledFont('Fira Sans', ['Arial', 'Inter']), false);
    });

    test('bounds font enumeration commands with a timeout', async () => {
        const fonts = await getInstalledFonts('linux', async (command, args, options) => {
            assert.strictEqual(command, 'fc-list');
            assert.deepStrictEqual(args, [':', 'family']);
            assert.strictEqual(options.timeout, FONT_ENUMERATION_TIMEOUT_MS);
            assert.strictEqual(options.windowsHide, true);
            return 'Inter\nJetBrains Mono';
        });

        assert.deepStrictEqual(fonts, ['Inter', 'JetBrains Mono']);
    });

    test('falls back to manual entry when font enumeration times out', async () => {
        const fonts = await getInstalledFonts('win32', async () => {
            const error = new Error('Font enumeration timed out');
            Object.assign(error, { code: 'ETIMEDOUT' });
            throw error;
        });

        assert.deepStrictEqual(fonts, []);
    });
});

suite('font picker ordering', () => {
    test('places the current font first, followed by recent and installed fonts', () => {
        assert.deepStrictEqual(
            prioritizeFontNames(['Arial', 'Inter', 'Verdana'], 'Inter', ['Verdana']),
            ['Inter', 'Verdana', 'Arial'],
        );
    });

    test('deduplicates font names case-insensitively', () => {
        assert.deepStrictEqual(
            prioritizeFontNames(['Inter', 'JetBrains Mono'], 'inter', ['INTER', 'Fira Sans']),
            ['inter', 'Fira Sans', 'JetBrains Mono'],
        );
    });

    test('ignores empty remembered font names', () => {
        assert.deepStrictEqual(prioritizeFontNames(['Inter'], ' ', ['', 'Inter']), ['Inter']);
    });
});

suite('getElevationHint', () => {
    test('tells Windows users to relaunch as administrator', () => {
        const hint = getElevationHint('win32');
        assert.ok(hint.includes('Run as administrator'), 'Windows hint should mention running as administrator');
        assert.ok(!hint.includes('sudo'), 'Windows hint should not suggest sudo');
    });

    test('tells macOS users to take ownership of the app bundle', () => {
        const hint = getElevationHint('darwin');
        assert.ok(hint.includes('sudo chown'), 'macOS hint should suggest chown');
        assert.ok(hint.includes('Visual Studio Code.app'), 'macOS hint should reference the app bundle');
    });

    test('tells Linux users to take ownership of the install directory', () => {
        const hint = getElevationHint('linux');
        assert.ok(hint.includes('sudo chown'), 'Linux hint should suggest chown');
        assert.ok(hint.includes('/usr/share/code'), 'Linux hint should reference the install directory');
    });

    test('falls back to the generic non-Windows hint for unknown platforms', () => {
        assert.strictEqual(getElevationHint('freebsd'), getElevationHint('linux'));
    });

    test('defaults to the current platform when no argument is supplied', () => {
        assert.strictEqual(getElevationHint(), getElevationHint(process.platform));
    });
});

suite('backup metadata', () => {
    test('accepts matching backup metadata', () => {
        const current = {
            version: 2,
            vscodeVersion: '1.2.3',
            appName: 'Visual Studio Code',
            appRoot: '/applications/code/resources/app',
            buildId: 'abc123',
        };

        assert.strictEqual(isBackupMetadataCurrent(current, current), true);
    });

    test('rejects mismatched backup metadata', () => {
        const current = {
            version: 2,
            vscodeVersion: '1.2.3',
            appName: 'Visual Studio Code',
            appRoot: '/applications/code/resources/app',
            buildId: 'abc123',
        };

        assert.strictEqual(isBackupMetadataCurrent({ ...current, vscodeVersion: '1.2.4' }, current), false);
        assert.strictEqual(isBackupMetadataCurrent({ ...current, appName: 'Code - Insiders' }, current), false);
        assert.strictEqual(isBackupMetadataCurrent({ ...current, appRoot: '/new/code/resources/app' }, current), false);
        assert.strictEqual(isBackupMetadataCurrent({ ...current, buildId: 'def456' }, current), false);
        assert.strictEqual(isBackupMetadataCurrent({ ...current, version: 1 }, current), false);
    });
});

suite('Extension integration', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('extension is present in the registered list', () => {
        // Try the published ID first, then fall back to displayName-based matches
        // so the test works in both the dev host and a packaged install.
        const ext = vscode.extensions.all.find(e =>
            e.id.toLowerCase().endsWith('.ui-font-changer-for-vscode') ||
            e.packageJSON?.name === 'ui-font-changer-for-vscode',
        );
        assert.ok(ext, 'ui-font-changer-for-vscode extension should be registered');
    });

    test('token-safe replacement updates the installed VS Code bundles', () => {
        const targets = getTargetFiles(vscode.env.appRoot);
        const namesToReplace = getDefaultFontsToReplaceForPlatform(process.platform);
        const bundlePaths = [
            targets.workbenchCss,
            targets.workbenchJs,
            targets.sessionsCss,
            targets.sessionsJs,
        ].filter(filePath => fs.existsSync(filePath));

        assert.ok(bundlePaths.length > 0, 'at least one VS Code UI bundle should exist');
        bundlePaths.forEach(filePath => {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (containsTargetFontReferences(content, namesToReplace)) {
                assert.notStrictEqual(
                    replaceFontInContent(content, 'Integration Test Font', namesToReplace),
                    content,
                    `${path.basename(filePath)} should contain a replaceable complete font family`,
                );
            }
        });
    });

    test('registers the ui-font-changer-for-vscode.change command', async () => {
        const ext = vscode.extensions.all.find(e =>
            e.id.toLowerCase().endsWith('.ui-font-changer-for-vscode') ||
            e.packageJSON?.name === 'ui-font-changer-for-vscode',
        );
        assert.ok(ext, 'ui-font-changer-for-vscode extension should be registered');

        // The command is contributed in package.json but only added to the command
        // registry once activate() runs, so ensure activation first.
        if (!ext.isActive) {
            await ext.activate();
        }

        const commands = await vscode.commands.getCommands(true);
        assert.ok(
            commands.includes('ui-font-changer-for-vscode.change'),
            'ui-font-changer-for-vscode.change command should be registered',
        );
        assert.ok(
            commands.includes('ui-font-changer-for-vscode.restore'),
            'ui-font-changer-for-vscode.restore command should be registered',
        );
        assert.ok(
            commands.includes('ui-font-changer-for-vscode.reapply'),
            'ui-font-changer-for-vscode.reapply command should be registered',
        );
    });

    test('package.json contributes the ui-font-changer-for-vscode.change command', () => {
        const ext = vscode.extensions.all.find(e =>
            e.id.toLowerCase().endsWith('.ui-font-changer-for-vscode') ||
            e.packageJSON?.name === 'ui-font-changer-for-vscode',
        );
        assert.ok(ext, 'ui-font-changer-for-vscode extension should be registered');

        const contributed: Array<{ command: string; title: string; category?: string }> =
            ext.packageJSON?.contributes?.commands ?? [];
        const entry = contributed.find(c => c.command === 'ui-font-changer-for-vscode.change');
        assert.ok(entry, 'ui-font-changer-for-vscode.change should be contributed in package.json');
        assert.strictEqual(entry.title, 'Change Font');
        assert.strictEqual(entry.category, 'UI Font Changer');

        const reapplyEntry = contributed.find(c => c.command === 'ui-font-changer-for-vscode.reapply');
        assert.ok(reapplyEntry, 'ui-font-changer-for-vscode.reapply should be contributed in package.json');
        assert.strictEqual(reapplyEntry.title, 'Reapply Font');
        assert.strictEqual(reapplyEntry.category, 'UI Font Changer');

        const restoreEntry = contributed.find(c => c.command === 'ui-font-changer-for-vscode.restore');
        assert.ok(restoreEntry, 'ui-font-changer-for-vscode.restore should be contributed in package.json');
        assert.strictEqual(restoreEntry.title, 'Restore Default Font');
        assert.strictEqual(restoreEntry.category, 'UI Font Changer');
    });

    test('activates after startup so the install welcome notification can be shown', () => {
        const ext = vscode.extensions.all.find(e =>
            e.id.toLowerCase().endsWith('.ui-font-changer-for-vscode') ||
            e.packageJSON?.name === 'ui-font-changer-for-vscode',
        );
        assert.ok(ext, 'ui-font-changer-for-vscode extension should be registered');
        assert.ok(
            ext.packageJSON?.activationEvents?.includes('onStartupFinished'),
            'extension should activate after startup to show the one-time welcome notification',
        );
    });
});
