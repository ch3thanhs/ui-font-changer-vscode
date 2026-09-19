import { execFile } from 'child_process';
import { promisify } from 'util';

/** Font strings inside workbench/sessions bundles that get replaced. */
export const DEFAULT_FONTS_TO_REPLACE: ReadonlyArray<string> = ['Segoe UI', 'Segoe WPC', 'Segoe'];
export const MACOS_FONTS_TO_REPLACE: ReadonlyArray<string> = ['BlinkMacSystemFont', '-apple-system'];
export const LINUX_FONTS_TO_REPLACE: ReadonlyArray<string> = ['Droid Sans', 'Ubuntu', 'system-ui'];
export const FONT_ENUMERATION_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);
const WINDOWS_PLATFORM = 'win32';
const MACOS_PLATFORM = 'darwin';
const LINUX_PLATFORM = 'linux';
const INVALID_FONT_NAME_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** Replace complete font-family entries matching `namesToReplace` with `fontName`. */
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

    return content.replace(regex, (match, quote: string, offset: number) => {
        if (quote) {
            return `${quote}${escapeFontNameForQuote(fontName, quote)}${quote}`;
        }

        if (!hasFontFamilyDelimiters(content, offset, match.length)) {
            return match;
        }

        return formatFontFamily(fontName);
    });
}

function hasFontFamilyDelimiters(content: string, offset: number, matchLength: number): boolean {
    const contentBeforeMatch = content.slice(0, offset).trimEnd();
    const contentAfterMatch = content.slice(offset + matchLength).trimStart();
    const hasStartDelimiter = contentBeforeMatch.length === 0 || /[,;:([{="']$/.test(contentBeforeMatch);
    const hasEndDelimiter = contentAfterMatch.length === 0
        || /^(?:[,;)}\]"']|!important\b)/.test(contentAfterMatch);

    return hasStartDelimiter && hasEndDelimiter;
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
    return /^[-_a-zA-Z][-_a-zA-Z0-9]*$/.test(fontName)
        ? fontName
        : `'${escapeFontNameForQuote(fontName, "'")}'`;
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

            return parseInstalledFontList(stdout);
        }

        const stdout = await runCommand('fc-list', [':', 'family'], commandOptions);
        return parseInstalledFontList(stdout);
    } catch {
        return [];
    }
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