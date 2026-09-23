import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

const require = createRequire(import.meta.url);

const {
    downloadAndUnzipVSCode,
    resolveCliArgsFromVSCodeExecutablePath,
} = require('@vscode/test-electron');

const { getTargetFiles } = require('../out/patcher.js');

const TEST_FONT = process.env.MACOS_UI_TEST_FONT;
const ARTIFACTS_DIR = path.resolve(
    process.env.MACOS_UI_ARTIFACTS_DIR ?? 'test-artifacts/macos-ui',
);

const COMMAND_NAME = 'UI Font Changer: Change Font';

function log(message) {
    console.log(`[macOS UI smoke] ${message}`);
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once('error', reject);

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();

            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Could not determine an available TCP port.'));
                return;
            }

            const port = address.port;

            server.close(error => {
                if (error) {
                    reject(error);
                } else {
                    resolve(port);
                }
            });
        });
    });
}

async function waitForRemoteDebugging(port, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}/json/version`;

    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);

            if (response.ok) {
                return;
            }
        } catch {
            // VS Code has not finished starting yet.
        }

        await delay(250);
    }

    throw new Error(`VS Code did not expose the Chrome DevTools endpoint on port ${port}.`);
}

async function launchVSCode(executablePath, userDataDir, extensionsDir, port) {
    const child = spawn(
        executablePath,
        [
            '--user-data-dir',
            userDataDir,
            '--extensions-dir',
            extensionsDir,
            '--remote-debugging-port',
            String(port),
            '--remote-allow-origins=*',
            '--disable-updates',
            '--disable-workspace-trust',
        ],
        {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ELECTRON_ENABLE_LOGGING: '1',
            },
        },
    );

    const stdout = [];
    const stderr = [];

    child.stdout?.on('data', chunk => stdout.push(chunk.toString()));
    child.stderr?.on('data', chunk => stderr.push(chunk.toString()));

    await waitForRemoteDebugging(port);

    return {
        child,
        stdout,
        stderr,
    };
}

async function stopVSCode(child) {
    if (!child || child.exitCode !== null) {
        return;
    }

    child.kill('SIGTERM');

    await new Promise(resolve => {
        const timer = setTimeout(() => {
            if (child.exitCode === null) {
                child.kill('SIGKILL');
            }
            resolve();
        }, 10_000);

        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function connectToWorkbench(port) {
    const browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${port}`,
    );

    const context = browser.contexts()[0];

    if (!context) {
        await browser.close();
        throw new Error('Playwright connected to VS Code but found no browser context.');
    }

    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
        for (const page of context.pages()) {
            try {
                if (await page.locator('.monaco-workbench').count()) {
                    await page.bringToFront();
                    await page
                        .locator('.monaco-workbench')
                        .waitFor({ state: 'visible', timeout: 5_000 });

                    return { browser, page };
                }
            } catch {
                // A page can disappear while VS Code is initializing.
            }
        }

        await delay(250);
    }

    await browser.close();
    throw new Error('Could not find the VS Code workbench page.');
}

async function getQuickInput(page, timeout = 30_000) {
    const input = page.locator('.quick-input-widget input').last();

    await input.waitFor({
        state: 'visible',
        timeout,
    });

    return input;
}

async function openCommandPalette(page) {
    // F1 opens the Command Palette on macOS without depending on
    // a particular keyboard-layout shortcut.
    await page.keyboard.press('F1');

    const input = await getQuickInput(page);

    await input.fill(COMMAND_NAME);
    await delay(200);

    const matchingCommand = page
        .locator('.quick-input-widget .monaco-list-row')
        .filter({ hasText: COMMAND_NAME })
        .first();

    await matchingCommand.waitFor({
        state: 'visible',
        timeout: 10_000,
    });

    await page.keyboard.press('Enter');
}

async function chooseFont(page, fontName) {
    const input = page.locator(
        '.quick-input-widget input[placeholder="Choose an installed font or enter a custom font"]',
    ).last();

    await input.waitFor({
        state: 'visible',
        timeout: 30_000,
    });

    await input.fill(fontName);
    await delay(300);

    const matchingFont = page
        .locator('.quick-input-widget .monaco-list-row')
        .filter({ hasText: fontName })
        .first();

    await matchingFont.waitFor({
        state: 'visible',
        timeout: 10_000,
    });

    await page.keyboard.press('Enter');
}

async function acceptModificationWarning(page) {
    const warning = page.getByText(
        'UI Font Changer modifies VS Code installation files.',
        { exact: false },
    );

    await warning.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    const continueButton = page.getByText('Continue', { exact: true }).last();

    if (await continueButton.count()) {
        await continueButton.click();
    } else {
        // Continue is the first/default action in this modal.
        await page.keyboard.press('Enter');
    }
}

function getInstalledMacFont() {
    let stdout;

    try {
        stdout = execFileSync(
            'fc-list',
            [':', 'family'],
            {
                encoding: 'utf8',
                timeout: 15_000,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
    } catch (error) {
        throw new Error(
            'macOS UI test requires "fc-list", because the extension uses fc-list to enumerate fonts on macOS. ' +
            'The GitHub runner does not appear to have it available.',
            { cause: error },
        );
    }

    const candidates = stdout
        .split(/\r?\n/)
        .flatMap(line => line.split(','))
        .map(value =>
            value
                .trim()
                .replace(/^"|"$/g, ''),
        )
        .filter(value =>
            value.length > 1 &&
            !value.startsWith('.'),
        );

    const unique = [...new Set(candidates)];

    if (unique.length === 0) {
        throw new Error('fc-list returned no usable installed macOS fonts.');
    }

    return unique[0];
}

function getMacOSAppRoot(vscodeExecutablePath) {
    // .../Visual Studio Code.app/Contents/MacOS/Code
    return path.resolve(
        path.dirname(vscodeExecutablePath),
        '..',
        'Resources',
        'app',
    );
}

async function captureScreenshot(page, filename) {
    await page.screenshot({
        path: path.join(ARTIFACTS_DIR, filename),
        fullPage: false,
    });
}

async function assertPatchedFiles(targets, originals, fontName) {
    const existingTargets = Object.values(targets).filter(existsSync);

    if (existingTargets.length === 0) {
        throw new Error('No VS Code files targeted by the extension were found.');
    }

    for (const target of existingTargets) {
        const original = originals.get(target);
        const updated = await readFile(target, 'utf8');

        if (updated === original) {
            throw new Error(
                `Expected ${path.basename(target)} to change after applying the font.`,
            );
        }

        if (!updated.toLocaleLowerCase().includes(fontName.toLocaleLowerCase())) {
            throw new Error(
                `Expected ${path.basename(target)} to contain "${fontName}" after patching.`,
            );
        }
    }
}

async function assertRenderedFont(page, fontName) {
    const result = await page.evaluate(font => {
        const wanted = font.toLocaleLowerCase();

        const elements = [
            document.documentElement,
            document.body,
            ...Array.from(
                document.querySelectorAll('.monaco-workbench *'),
            ).slice(0, 5000),
        ];

        const matches = [];

        for (const element of elements) {
            const computed = getComputedStyle(element).fontFamily ?? '';

            if (computed.toLocaleLowerCase().includes(wanted)) {
                matches.push({
                    element: element.tagName,
                    className: typeof element.className === 'string'
                        ? element.className
                        : '',
                    fontFamily: computed,
                });
            }

            if (matches.length >= 10) {
                break;
            }
        }

        return {
            matches,
            workbenchFontFamily: getComputedStyle(
                document.querySelector('.monaco-workbench') ?? document.body,
            ).fontFamily,
        };
    }, fontName);

    log(`Rendered workbench font-family: ${result.workbenchFontFamily}`);

    if (result.matches.length === 0) {
        throw new Error(
            `After restarting VS Code, no rendered UI element used "${fontName}".`,
        );
    }

    log(
        `Found ${result.matches.length} rendered UI element(s) using "${fontName}".`,
    );
}

async function main() {
    if (process.platform !== 'darwin') {
        throw new Error('This smoke test must run on macOS.');
    }

    await mkdir(ARTIFACTS_DIR, { recursive: true });

    const vsixPath =
        process.env.VSIX_PATH ??
        path.resolve('ui-font-changer-for-vscode.vsix');

    if (!existsSync(vsixPath)) {
        throw new Error(`VSIX not found: ${vsixPath}`);
    }

    const fontName = TEST_FONT ?? getInstalledMacFont();

    log(`Testing with installed font: ${fontName}`);

    const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
    const appRoot = getMacOSAppRoot(vscodeExecutablePath);
    const targets = getTargetFiles(appRoot);

    log(`VS Code executable: ${vscodeExecutablePath}`);
    log(`VS Code app root: ${appRoot}`);

    const originals = new Map();

    for (const target of Object.values(targets)) {
        if (existsSync(target)) {
            originals.set(target, await readFile(target, 'utf8'));
        }
    }

    const userDataDir = await mkdtemp(
        path.join(os.tmpdir(), 'ui-font-changer-macos-ui-'),
    );
    const extensionsDir = path.join(userDataDir, 'extensions');

    await mkdir(extensionsDir, { recursive: true });

    const [cli, ...cliArgs] =
        resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

    log('Installing the test VSIX into an isolated VS Code profile...');

    execFileSync(
        cli,
        [
            ...cliArgs,
            '--user-data-dir',
            userDataDir,
            '--extensions-dir',
            extensionsDir,
            '--install-extension',
            vsixPath,
            '--force',
        ],
        {
            stdio: 'inherit',
        },
    );

    let firstRun;
    let firstBrowser;

    try {
        const firstPort = await getFreePort();

        log('Launching VS Code for the first UI interaction...');

        firstRun = await launchVSCode(
            vscodeExecutablePath,
            userDataDir,
            extensionsDir,
            firstPort,
        );

        firstBrowser = await connectToWorkbench(firstPort);

        const { page } = firstBrowser;

        await captureScreenshot(page, '01-before-change.png');

        log('Opening the Command Palette...');
        await openCommandPalette(page);

        log('Selecting an installed font...');
        await chooseFont(page, fontName);

        log('Accepting the extension modification warning...');
        await acceptModificationWarning(page);

        const successMessage = page.getByText(
            `Font changed to ${fontName}`,
            { exact: false },
        );

        await successMessage.waitFor({
            state: 'visible',
            timeout: 60_000,
        });

        await captureScreenshot(page, '02-after-apply-before-restart.png');

        await assertPatchedFiles(targets, originals, fontName);

        log('The extension successfully patched the downloaded VS Code installation.');
    } finally {
        if (firstBrowser) {
            await firstBrowser.browser.close().catch(() => {});
        }

        await stopVSCode(firstRun?.child);
    }

    await writeFile(
        path.join(ARTIFACTS_DIR, 'first-run-stdout.log'),
        firstRun?.stdout?.join('') ?? '',
    );

    await writeFile(
        path.join(ARTIFACTS_DIR, 'first-run-stderr.log'),
        firstRun?.stderr?.join('') ?? '',
    );

    let secondRun;
    let secondBrowser;

    try {
        const secondPort = await getFreePort();

        log('Restarting the same patched VS Code installation...');

        secondRun = await launchVSCode(
            vscodeExecutablePath,
            userDataDir,
            extensionsDir,
            secondPort,
        );

        secondBrowser = await connectToWorkbench(secondPort);

        const { page } = secondBrowser;

        await delay(2_000);

        await captureScreenshot(page, '03-after-restart.png');

        await assertRenderedFont(page, fontName);

        log('macOS UI smoke test passed.');
    } finally {
        if (secondBrowser) {
            await secondBrowser.browser.close().catch(() => {});
        }

        await stopVSCode(secondRun?.child);

        await writeFile(
            path.join(ARTIFACTS_DIR, 'second-run-stdout.log'),
            secondRun?.stdout?.join('') ?? '',
        );

        await writeFile(
            path.join(ARTIFACTS_DIR, 'second-run-stderr.log'),
            secondRun?.stderr?.join('') ?? '',
        );

        await rm(userDataDir, {
            recursive: true,
            force: true,
        });
    }
}

main().catch(async error => {
    console.error(error);

    // Keep the artifact directory even on failure so screenshots/logs
    // produced before the failure can be uploaded by GitHub Actions.
    await mkdir(ARTIFACTS_DIR, { recursive: true }).catch(() => {});

    process.exitCode = 1;
});