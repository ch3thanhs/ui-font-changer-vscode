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

const COMMAND_NAME = 'Change Font';

function log(message) {
    console.log(`[macOS UI smoke] ${message}`);
}

async function sleep(ms) {
    await delay(ms);
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once('error', reject);

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();

            if (!address || typeof address === 'string') {
                server.close();
                reject(
                    new Error('Could not determine a free TCP port.'),
                );
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

function extractDevToolsEndpoint(text) {
    const match = text.match(
        /DevTools listening on (ws:\/\/[^\s]+)/,
    );

    return match?.[1] ?? null;
}

async function waitForDevToolsEndpoint(
    run,
    timeoutMs = 60_000,
) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (run.child.exitCode !== null) {
            throw new Error(
                `VS Code exited before its DevTools endpoint ` +
                `became available. exitCode=${run.child.exitCode}`,
            );
        }

        const endpoint = run.getDevToolsEndpoint();

        if (endpoint) {
            return endpoint;
        }

        await sleep(100);
    }

    throw new Error(
        'Timed out waiting for VS Code to announce its ' +
        'DevTools websocket endpoint.',
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

    const child = spawn(
        executablePath,
        args,
        {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ELECTRON_ENABLE_LOGGING: '1',
            },
        },
    );

    const stdout = [];
    const stderr = [];

    let devToolsEndpoint = null;

    const processOutput = (text, output, label) => {
        output.push(text);

        const endpoint = extractDevToolsEndpoint(text);

        if (endpoint && !devToolsEndpoint) {
            devToolsEndpoint = endpoint;

            log(
                `Detected VS Code DevTools endpoint: ${endpoint}`,
            );
        }

        process.stdout.write(
            `[VS Code ${label}] ${text}`,
        );
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', data => {
        processOutput(
            data.toString(),
            stdout,
            'stdout',
        );
    });

    child.stderr?.on('data', data => {
        processOutput(
            data.toString(),
            stderr,
            'stderr',
        );
    });

    child.once('error', error => {
        console.error(
            `[VS Code spawn error] ${error.stack ?? error}`,
        );
    });

    child.once('exit', (code, signal) => {
        log(
            `VS Code exited: code=${code}, signal=${signal}`,
        );
    });

    return {
        child,
        stdout,
        stderr,
        getDevToolsEndpoint: () => devToolsEndpoint,
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
                log(
                    'VS Code did not exit cleanly; sending SIGKILL.',
                );

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

async function connectToWorkbench(run) {
    log('Waiting for VS Code DevTools endpoint...');

    const endpoint = await waitForDevToolsEndpoint(run);

    log(`Connecting Playwright to ${endpoint}`);

    let browser;

    try {
        browser = await chromium.connectOverCDP(endpoint);
    } catch (error) {
        throw new Error(
            `Playwright failed to connect to VS Code DevTools ` +
            `endpoint: ${endpoint}`,
            {
                cause: error,
            },
        );
    }

    log(
        `Playwright connected. Contexts: ` +
        `${browser.contexts().length}`,
    );

    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
        const contexts = browser.contexts();

        for (const context of contexts) {
            const pages = context.pages();

            log(
                `Found ${pages.length} page(s) in VS Code context.`,
            );

            for (const page of pages) {
                try {
                    const url = page.url();

                    log(`Inspecting page: ${url}`);

                    const workbench = page.locator(
                        '.monaco-workbench',
                    );

                    const count = await workbench.count();

                    log(
                        `Workbench elements found: ${count}`,
                    );

                    if (count === 0) {
                        continue;
                    }

                    await workbench.first().waitFor({
                        state: 'visible',
                        timeout: 5_000,
                    });

                    await page.bringToFront();

                    log('VS Code workbench is ready.');

                    return {
                        browser,
                        page,
                    };
                } catch (error) {
                    log(
                        `Page not ready yet: ` +
                        `${
                            error instanceof Error
                                ? error.message
                                : String(error)
                        }`,
                    );
                }
            }
        }

        await sleep(500);
    }

    await browser.close();

    throw new Error(
        'Timed out waiting for a visible VS Code workbench.',
    );
}

async function waitForQuickInput(
    page,
    timeout = 30_000,
) {
    const input = page
        .locator('.quick-input-widget input')
        .last();

    await input.waitFor({
        state: 'visible',
        timeout,
    });

    return input;
}

async function waitForFontPicker(
    page,
    timeout = 30_000,
) {
    const title = page.getByText(
        'Select the UI font',
        {
            exact: true,
        },
    );

    try {
        await title.waitFor({
            state: 'visible',
            timeout,
        });

        log('UI font picker is open.');

        return;
    } catch {
        const inputs = page.locator(
            '.quick-input-widget input',
        );

        const inputCount = await inputs.count();

        const visibleInputs = [];

        for (let index = 0; index < inputCount; index += 1) {
            const input = inputs.nth(index);

            if (await input.isVisible().catch(() => false)) {
                visibleInputs.push({
                    index,
                    value: await input
                        .inputValue()
                        .catch(() => ''),
                    placeholder: await input
                        .getAttribute('placeholder')
                        .catch(() => null),
                });
            }
        }

        throw new Error(
            `The "${COMMAND_NAME}" command was not opened. ` +
            `Visible Quick Input inputs: ` +
            `${JSON.stringify(visibleInputs)}`,
        );
    }
}

async function openCommandPalette(page) {
    log(
        `Opening Command Palette and selecting "${COMMAND_NAME}"...`,
    );

    await page.keyboard.press('F1');

    const input = await waitForQuickInput(page);

    await input.fill(COMMAND_NAME);

    await sleep(500);

    /*
     * Do not depend on VS Code's internal list-row DOM here.
     *
     * Command contributions define:
     *
     *   title: "Change Font"
     *   category: "UI Font Changer"
     *
     * The category is metadata and may not be rendered as part of
     * the option's accessible/text content.
     *
     * Quick Pick accepts the currently selected result with Enter.
     */
    log(
        `Accepting the "${COMMAND_NAME}" Command Palette result...`,
    );

    await page.keyboard.press('Enter');

    await waitForFontPicker(page);
}

async function selectFont(page, fontName) {
    log(
        `Looking for discovered font "${fontName}"...`,
    );

    const input = await waitForQuickInput(page);

    await input.fill(fontName);

    await sleep(500);

    /*
     * Prefer the accessible option role because it is less coupled
     * to VS Code's internal list CSS classes.
     */
    const option = page
        .getByRole('option', {
            name: new RegExp(
                `^${escapeRegExp(fontName)}(?:\\s|$)`,
                'i',
            ),
        })
        .first();

    if (await option.count()) {
        await option.waitFor({
            state: 'visible',
            timeout: 10_000,
        });

        await option.click();

        log(
            `Selected discovered font "${fontName}".`,
        );

        return;
    }

    /*
     * Fallback: use keyboard navigation.
     *
     * After filtering the Quick Pick to an exact installed font
     * name, the first matching result should be active.
     */
    log(
        `Could not locate "${fontName}" as an accessible option; ` +
        'using keyboard selection.',
    );

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
}

function escapeRegExp(value) {
    return value.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
    );
}

async function acceptModificationWarning(page) {
    log(
        'Waiting for the modification warning...',
    );

    const warning = page.getByText(
        'UI Font Changer modifies VS Code installation files.',
        {
            exact: false,
        },
    );

    await warning.waitFor({
        state: 'visible',
        timeout: 20_000,
    });

    const continueButton = page
        .getByText('Continue', {
            exact: true,
        })
        .last();

    await continueButton.waitFor({
        state: 'visible',
        timeout: 10_000,
    });

    await continueButton.click();
}

async function waitForSuccess(
    page,
    fontName,
) {
    log(
        `Waiting for successful font change to "${fontName}"...`,
    );

    /*
     * The extension's actual message includes a surface summary
     * after "Font changed to <font>.", so match only the stable
     * beginning of the message.
     */
    const message = page.getByText(
        `Font changed to ${fontName}.`,
        {
            exact: false,
        },
    );

    await message.waitFor({
        state: 'visible',
        timeout: 60_000,
    });
}

async function captureScreenshot(
    page,
    filename,
) {
    const screenshotPath = path.join(
        ARTIFACTS_DIR,
        filename,
    );

    await page.screenshot({
        path: screenshotPath,
        fullPage: false,
    });

    log(
        `Screenshot saved: ${screenshotPath}`,
    );
}

async function assertPatchedFiles(
    targets,
    originalContents,
    fontName,
) {
    const existingTargets = Object.values(targets)
        .filter(existsSync);

    if (existingTargets.length === 0) {
        throw new Error(
            'None of the expected VS Code UI files exist.',
        );
    }

    let changedCount = 0;

    for (const target of existingTargets) {
        const original = originalContents.get(target);

        if (original === undefined) {
            continue;
        }

        const updated = await readFile(
            target,
            'utf8',
        );

        if (updated !== original) {
            changedCount += 1;
        }

        if (!updated.toLocaleLowerCase().includes(
            fontName.toLocaleLowerCase(),
        )) {
            throw new Error(
                `${path.basename(target)} does not contain ` +
                `"${fontName}" after the extension applied ` +
                'the change.',
            );
        }
    }

    if (changedCount === 0) {
        throw new Error(
            'The extension reported success, but none of the ' +
            'VS Code files changed.',
        );
    }

    log(
        `Verified ${changedCount} patched VS Code UI file(s).`,
    );
}

async function assertRenderedFont(
    page,
    fontName,
) {
    log(
        `Checking rendered UI for "${fontName}"...`,
    );

    const result = await page.evaluate(font => {
        const wanted = font.toLocaleLowerCase();

        const workbench = document.querySelector(
            '.monaco-workbench',
        );

        const elements = [
            document.documentElement,
            document.body,
            workbench,
            ...Array.from(
                document.querySelectorAll(
                    '.monaco-workbench *',
                ),
            ).slice(0, 5000),
        ].filter(Boolean);

        const matches = [];

        for (const element of elements) {
            const computed = getComputedStyle(
                element,
            ).fontFamily ?? '';

            if (
                computed
                    .toLocaleLowerCase()
                    .includes(wanted)
            ) {
                matches.push({
                    tag: element.tagName,
                    className:
                        typeof element.className === 'string'
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
                workbench ?? document.body,
            ).fontFamily,
        };
    }, fontName);

    log(
        `Workbench computed font-family: ` +
        `${result.workbenchFontFamily}`,
    );

    if (result.matches.length === 0) {
        throw new Error(
            `After restart, no visible workbench element uses ` +
            `"${fontName}".`,
        );
    }

    log(
        `Found ${result.matches.length} rendered element(s) ` +
        `using "${fontName}".`,
    );
}

async function writeLogs(
    run,
    prefix,
) {
    if (!run) {
        return;
    }

    await writeFile(
        path.join(
            ARTIFACTS_DIR,
            `${prefix}-stdout.log`,
        ),
        run.stdout.join(''),
    );

    await writeFile(
        path.join(
            ARTIFACTS_DIR,
            `${prefix}-stderr.log`,
        ),
        run.stderr.join(''),
    );
}

function resolveVSCodeCli(
    vscodeExecutablePath,
) {
    /*
     * Suppress the automatically generated isolated profile
     * arguments from @vscode/test-electron because this test
     * supplies its own short /tmp profile paths.
     */
    return resolveCliArgsFromVSCodeExecutablePath(
        vscodeExecutablePath,
        {
            reuseMachineInstall: true,
        },
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
        throw new Error(
            `VSIX does not exist: ${VSIX_PATH}`,
        );
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

    await mkdir(
        ARTIFACTS_DIR,
        {
            recursive: true,
        },
    );

    if (!existsSync(VSIX_PATH)) {
        throw new Error(
            `VSIX does not exist: ${VSIX_PATH}`,
        );
    }

    log(
        `Testing font: ${TEST_FONT}`,
    );

    /*
     * Keep the profile path short.
     *
     * GitHub Actions workspace paths can be deep enough to cause
     * macOS/Electron IPC socket path issues.
     */
    const userDataDir = await mkdtemp(
        '/tmp/uifc-user-',
    );

    const extensionsDir = path.join(
        userDataDir,
        'extensions',
    );

    await mkdir(
        extensionsDir,
        {
            recursive: true,
        },
    );

    const vscodeExecutablePath =
        await downloadAndUnzipVSCode('stable');

    log(
        `VS Code executable: ${vscodeExecutablePath}`,
    );

    const [cli, ...cliArgs] =
        resolveVSCodeCli(
            vscodeExecutablePath,
        );

    await installVSIX(
        cli,
        cliArgs,
        userDataDir,
        extensionsDir,
    );

    /*
     * This is the same target resolution used by the extension.
     */
    const appRoot = path.resolve(
        path.dirname(vscodeExecutablePath),
        '..',
        'Resources',
        'app',
    );

    const targets = getTargetFiles(
        appRoot,
    );

    const originalContents = new Map();

    for (const target of Object.values(targets)) {
        if (existsSync(target)) {
            originalContents.set(
                target,
                await readFile(
                    target,
                    'utf8',
                ),
            );
        }
    }

    let firstRun;
    let firstBrowser;

    try {
        const firstPort =
            await getFreePort();

        log(
            `Using DevTools port ${firstPort}.`,
        );

        firstRun = launchVSCode(
            vscodeExecutablePath,
            userDataDir,
            extensionsDir,
            firstPort,
        );

        firstBrowser =
            await connectToWorkbench(
                firstRun,
            );

        const { page } = firstBrowser;

        await captureScreenshot(
            page,
            '01-before-change.png',
        );

        await openCommandPalette(
            page,
        );

        await selectFont(
            page,
            TEST_FONT,
        );

        await acceptModificationWarning(
            page,
        );

        await waitForSuccess(
            page,
            TEST_FONT,
        );

        await captureScreenshot(
            page,
            '02-after-apply.png',
        );

        await assertPatchedFiles(
            targets,
            originalContents,
            TEST_FONT,
        );

        log(
            'First phase passed.',
        );
    } finally {
        if (firstBrowser) {
            await firstBrowser.browser
                .close()
                .catch(() => undefined);
        }

        await stopVSCode(
            firstRun?.child,
        );

        await writeLogs(
            firstRun,
            'first-run',
        );
    }

    let secondRun;
    let secondBrowser;

    try {
        const secondPort =
            await getFreePort();

        log(
            `Using DevTools port ${secondPort} for restart.`,
        );

        secondRun = launchVSCode(
            vscodeExecutablePath,
            userDataDir,
            extensionsDir,
            secondPort,
        );

        secondBrowser =
            await connectToWorkbench(
                secondRun,
            );

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

        log(
            'macOS UI smoke test passed.',
        );
    } finally {
        if (secondBrowser) {
            await secondBrowser.browser
                .close()
                .catch(() => undefined);
        }

        await stopVSCode(
            secondRun?.child,
        );

        await writeLogs(
            secondRun,
            'second-run',
        );

        await rm(
            userDataDir,
            {
                recursive: true,
                force: true,
            },
        );
    }
}

main().catch(async error => {
    console.error(error);

    await mkdir(
        ARTIFACTS_DIR,
        {
            recursive: true,
        },
    ).catch(() => undefined);

    process.exitCode = 1;
});