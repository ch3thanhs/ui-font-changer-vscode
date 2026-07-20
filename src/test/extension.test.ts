import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    containsTargetFontReferences,
    DEFAULT_FONTS_TO_REPLACE,
    buildMarkdownRule,
    getDefaultFontsToReplaceForPlatform,
    getTargetFiles,
    isBackupMetadataCurrent,
    LINUX_FONTS_TO_REPLACE,
    MACOS_FONTS_TO_REPLACE,
    normalizeFontFamilyName,
    parseInstalledFontList,
    replaceFontInContent,
} from '../extension';

suite('replaceFontInContent', () => {
    test('replaces all three default Segoe variants', () => {
        const input = 'font-family: "Segoe WPC", "Segoe UI", Segoe, sans-serif;';
        const out = replaceFontInContent(input, 'Inter');
        assert.strictEqual(out, 'font-family: "Inter", "Inter", Inter, sans-serif;');
    });

    test('replaces every occurrence (global flag)', () => {
        const input = 'Segoe UI Segoe UI Segoe UI';
        const out = replaceFontInContent(input, 'Inter');
        assert.strictEqual(out, 'Inter Inter Inter');
    });

    test('"Segoe UI" is replaced before bare "Segoe" (no partial collisions)', () => {
        // If 'Segoe' were processed first, 'Segoe UI' would become 'Inter UI'.
        const input = 'Segoe UI and Segoe alone';
        const out = replaceFontInContent(input, 'Inter');
        assert.strictEqual(out, 'Inter and Inter alone');
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
        const input = 'foo.bar baz';
        const out = replaceFontInContent(input, 'X', ['foo.bar']);
        assert.strictEqual(out, 'X baz');
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
});

suite('backup metadata', () => {
    test('accepts matching backup metadata', () => {
        const current = {
            version: 1,
            vscodeVersion: '1.2.3',
            appName: 'Visual Studio Code',
        };

        assert.strictEqual(isBackupMetadataCurrent(current, current), true);
    });

    test('rejects mismatched backup metadata', () => {
        const current = {
            version: 1,
            vscodeVersion: '1.2.3',
            appName: 'Visual Studio Code',
        };

        assert.strictEqual(isBackupMetadataCurrent({ ...current, vscodeVersion: '1.2.4' }, current), false);
        assert.strictEqual(isBackupMetadataCurrent({ ...current, appName: 'Code - Insiders' }, current), false);
        assert.strictEqual(isBackupMetadataCurrent({ ...current, version: 2 }, current), false);
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
    });

    test('package.json contributes the ui-font-changer-for-vscode.change command', () => {
        const ext = vscode.extensions.all.find(e =>
            e.id.toLowerCase().endsWith('.ui-font-changer-for-vscode') ||
            e.packageJSON?.name === 'ui-font-changer-for-vscode',
        );
        assert.ok(ext, 'ui-font-changer-for-vscode extension should be registered');

        const contributed: Array<{ command: string; title: string }> =
            ext.packageJSON?.contributes?.commands ?? [];
        const entry = contributed.find(c => c.command === 'ui-font-changer-for-vscode.change');
        assert.ok(entry, 'ui-font-changer-for-vscode.change should be contributed in package.json');
        assert.strictEqual(entry.title, 'Change UI font');

        const restoreEntry = contributed.find(c => c.command === 'ui-font-changer-for-vscode.restore');
        assert.ok(restoreEntry, 'ui-font-changer-for-vscode.restore should be contributed in package.json');
        assert.strictEqual(restoreEntry.title, 'Restore UI font');
    });
});
