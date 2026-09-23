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

import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);

const {
    downloadAndUnzipVSCode,
    resolveCliArgsFromVSCodeExecutablePath,
} = require('@vscode/test-electron');

const { getTargetFiles } = require('../out/patcher.js');

const ARTIFACTS_DIR = path.resolve(
    process.env.MACOS_UI_ARTIFACTS_DIR ?? 'test-artifacts/macos-ui',
);

const VSIX_PATH = process.env.VSIX_PATH
    ? path.resolve(process.env.VSIX_PATH)
    : path.resolve('ui-font-changer-for-vscode.vsix');

const TEST_FONT = process.env.MACOS_UI_TEST_FONT ?? 'Helvetica';

const COMMAND_NAME = 'UI Font Changer: Change Font';

function log(message) {
    console.log(`[macOS UI smoke] ${message}`);
}

async function sleep(ms) {
    await delay(ms);
}

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once('error', reject);

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();

            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Could not determine a free TCP port.'));
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

async function waitForCDP(port, child, timeoutMs = 60_000) {
    const endpoint = `http://127.0.0.1:${port}/json/version`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(
                `VS Code exited before CDP became available. ` +
                `exitCode=${child.exitCode}`,
            );
        }

        try {
            const response = await fetch(endpoint);

            if (response.ok) {
                log(`CDP endpoint is available on port ${port}.`);
                return;
            }
        } catch {
            // VS Code is still starting.
        }

        await sleep(250);
    }

    throw new Error(
        `VS Code did not expose the Chrome DevTools endpoint on port ${port}.`,
    );
}

function launchVSCode(
    executablePath,
    userDataDir,
    extensionsDir,
    port,
) {
    const args = [
        '--enable-smoke-test-driver',
        '--disable-workspace-trust',
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--new-window',
    ];

    log(`Launching VS Code: ${executablePath}`);
    log(`Arguments: ${args.join(' ')}`);

    const child = spawn(executablePath, args, {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            ELECTRON_ENABLE_LOGGING: '1',
        },
    });

    const stdout = [];
    const stderr = [];

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', data => {
        const text = data.toString();
        stdout.push(text);
        process.stdout.write(`[VS Code stdout] ${text}`);
    });

    child.stderr?.on('data', data => {
        const text = data.toString();
        stderr.push(text);
        process.stderr.write(`[VS Code stderr] ${text}`);
    });

    child.once('error', error => {
        console.error(`[VS Code spawn error] ${error.stack ?? error}`);
    });

    child.once('exit', (code, signal) => {
        log(`VS Code exited: code=${code}, signal=${signal}`);
    });

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

    log('Stopping VS Code...');

    child.kill('SIGTERM');

    await new Promise(resolve => {
        const timer = setTimeout(() => {
            if (child.exitCode === null) {
                log('VS Code did not exit cleanly; sending SIGKILL.');
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
    await waitForCDP(port);

    const browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${port}`,
    );

    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
        const pages = browser.contexts().flatMap(
            context => context.pages(),
        );

        for (const page of pages) {
            const hasDriver = await page.evaluate(() => (
                typeof globalThis.driver?.whenWorkbenchRestored === 'function'
            )).catch(() => false);

            if (!hasDriver) {
                continue;
            }

            await page.evaluate(
                () => globalThis.driver.whenWorkbenchRestored(),
            );

            await page.bringToFront();

            return {
                browser,
                page,
            };
        }

        await sleep(500);
    }

    await browser.close();

    throw new Error(
        'Timed out waiting for the VS Code workbench smoke-test driver.',
    );
}

async function waitForQuickInput(page, timeout = 30_000) {
    const input = page.locator('.quick-input-widget input').last();

    await input.waitFor({
        state: 'visible',
        timeout,
    });

    return input;
}

async function openCommandPalette(page) {
    log('Opening Command Palette...');

    await page.keyboard.press('F1');

    const input = await waitForQuickInput(page);

    await input.fill(COMMAND_NAME);

    await sleep(300);

    const command = page
        .locator('.quick-input-widget .monaco-list-row')
        .filter({ hasText: COMMAND_NAME })
        .first();

    await command.waitFor({
        state: 'visible',
        timeout: 10_000,
    });

    await command.click();
}

async function selectFont(page, fontName) {
    log(`Looking for discovered font "${fontName}"...`);

    const input = page.locator('.quick-input-widget input').last();

    await input.waitFor({
        state: 'visible',
        timeout: 30_000,
    });

    await input.fill(fontName);

    await sleep(500);

    const fontRow = page
        .locator('.quick-input-widget .monaco-list-row')
        .filter({ hasText: fontName })
        .first();

    if (await fontRow.count() === 0) {
        throw new Error(
            `Font "${fontName}" was not discovered by the extension. ` +
            `This test intentionally requires the font to appear in the installed-font list.`,
        );
    }

    await fontRow.waitFor({
        state: 'visible',
        timeout: 10_000,
    });

    await fontRow.click();
}

async function acceptModificationWarning(page) {
    log('Waiting for the modification warning...');

    const warning = page.getByText(
        'UI Font Changer modifies VS Code installation files.',
        { exact: false },
    );

    await warning.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    const continueButton = page
        .getByText('Continue', { exact: true })
        .last();

    await continueButton.click();
}

async function waitForSuccess(page, fontName) {
    const message = page.getByText(
        `Font changed to ${fontName}.`,
        { exact: false },
    );

    await message.waitFor({
        state: 'visible',
        timeout: 60_000,
    });
}

async function captureScreenshot(page, filename) {
    await page.screenshot({
        path: path.join(ARTIFACTS_DIR, filename),
        fullPage: false,
    });
}

async function assertPatchedFiles(
    targets,
    originalContents,
    fontName,
) {
    const existingTargets = Object.values(targets).filter(existsSync);

    if (existingTargets.length === 0) {
        throw new Error(
            'None of the expected VS Code UI files exist.',
        );
    }

    let changedCount = 0;

    for (const target of existingTargets) {
        const original = originalContents.get(target);
        const updated = await readFile(target, 'utf8');

        if (original === undefined) {
            continue;
        }

        if (updated !== original) {
            changedCount += 1;
        }

        if (!updated.toLocaleLowerCase().includes(
            fontName.toLocaleLowerCase(),
        )) {
            throw new Error(
                `${path.basename(target)} does not contain "${fontName}" ` +
                'after the extension applied the change.',
            );
        }
    }

    if (changedCount === 0) {
        throw new Error(
            'The extension reported success, but none of the VS Code files changed.',
        );
    }

    log(`Verified ${changedCount} patched VS Code UI file(s).`);
}

async function assertRenderedFont(page, fontName) {
    log(`Checking rendered UI for "${fontName}"...`);

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
                    tag: element.tagName,
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
                document.querySelector('.monaco-workbench')
                    ?? document.body,
            ).fontFamily,
        };
    }, fontName);

    log(
        `Workbench computed font-family: ${result.workbenchFontFamily}`,
    );

    if (result.matches.length === 0) {
        throw new Error(
            `After restart, no visible workbench element uses "${fontName}".`,
        );
    }

    log(
        `Found ${result.matches.length} rendered element(s) using "${fontName}".`,
    );
}

async function writeLogs(run, prefix) {
    if (!run) {
        return;
    }

    await writeFile(
        path.join(ARTIFACTS_DIR, `${prefix}-stdout.log`),
        run.stdout.join(''),
    );

    await writeFile(
        path.join(ARTIFACTS_DIR, `${prefix}-stderr.log`),
        run.stderr.join(''),
    );
}

async function installVSIX(
    cli,
    cliArgs,
    userDataDir,
    extensionsDir,
) {
    log(`Installing VSIX: ${VSIX_PATH}`);

    if (!existsSync(VSIX_PATH)) {
        throw new Error(`VSIX does not exist: ${VSIX_PATH}`);
    }

    execFileSync(
        cli,
        [
            ...cliArgs,
            `--user-data-dir=${userDataDir}`,
            `--extensions-dir=${extensionsDir}`,
            '--install-extension',
            VSIX_PATH,
            '--force',
        ],
        {
            stdio: 'inherit',
        },
    );
}

async function main() {
    if (process.platform !== 'darwin') {
        throw new Error(
            'macos-ui-smoke.mjs must be run on macOS.',
        );
    }

    await mkdir(ARTIFACTS_DIR, { recursive: true });

    if (!existsSync(VSIX_PATH)) {
        throw new Error(`VSIX does not exist: ${VSIX_PATH}`);
    }

    log(`Testing font: ${TEST_FONT}`);

    /*
     * Keep the profile path deliberately short.
     *
     * macOS Electron/VS Code has IPC socket path limits, so using /tmp
     * avoids the long GitHub Actions workspace path.
     */
    const userDataDir = await mkdtemp('/tmp/uifc-user-');
    const extensionsDir = path.join(userDataDir, 'extensions');

    await mkdir(extensionsDir, { recursive: true });

    const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');

    log(`VS Code executable: ${vscodeExecutablePath}`);

    const [cli, ...cliArgs] =
        resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

    await installVSIX(
        cli,
        cliArgs,
        userDataDir,
        extensionsDir,
    );

    const appRoot = path.resolve(
        path.dirname(vscodeExecutablePath),
        '..',
        'Resources',
        'app',
    );

    const targets = getTargetFiles(appRoot);
    const originalContents = new Map();

    for (const target of Object.values(targets)) {
        if (existsSync(target)) {
            originalContents.set(
                target,
                await readFile(target, 'utf8'),
            );
        }
    }

    let firstRun;
    let firstBrowser;

    try {
        const firstPort = await getFreePort();

        log('Launching VS Code for UI test...');

        firstRun = launchVSCode(
            vscodeExecutablePath,
            userDataDir,
            extensionsDir,
            firstPort,
        );

        firstBrowser = await connectToWorkbench(firstPort);

        const { page } = firstBrowser;

        await captureScreenshot(
            page,
            '01-before-change.png',
        );

        await openCommandPalette(page);
        await selectFont(page, TEST_FONT);
        await acceptModificationWarning(page);
        await waitForSuccess(page, TEST_FONT);

        await captureScreenshot(
            page,
            '02-after-apply.png',
        );

        await assertPatchedFiles(
            targets,
            originalContents,
            TEST_FONT,
        );

        log('First phase passed.');
    } finally {
        if (firstBrowser) {
            await firstBrowser.browser
                .close()
                .catch(() => undefined);
        }

        await stopVSCode(firstRun?.child);
        await writeLogs(firstRun, 'first-run');
    }

    let secondRun;
    let secondBrowser;

    try {
        const secondPort = await getFreePort();

        log('Restarting VS Code...');

        secondRun = launchVSCode(
            vscodeExecutablePath,
            userDataDir,
            extensionsDir,
            secondPort,
        );

        secondBrowser = await connectToWorkbench(secondPort);

        const { page } = secondBrowser;

        await sleep(2_000);

        await captureScreenshot(
            page,
            '03-after-restart.png',
        );

        await assertRenderedFont(
            page,
            TEST_FONT,
        );

        log('macOS UI smoke test passed.');
    } finally {
        if (secondBrowser) {
            await secondBrowser.browser
                .close()
                .catch(() => undefined);
        }

        await stopVSCode(secondRun?.child);
        await writeLogs(secondRun, 'second-run');

        await rm(userDataDir, {
            recursive: true,
            force: true,
        });
    }
}

main().catch(async error => {
    console.error(error);

    await mkdir(ARTIFACTS_DIR, {
        recursive: true,
    }).catch(() => undefined);

    process.exitCode = 1;
});