import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { NativeJudge, isJudgmentApi } from '@oh-my-pi/pi-ai';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Watches main-session shell commands and eval code for operations the built-in
 * tools APPEND_SYSTEM.md assigns to the model: list, read, search, edit, write
 * and eval. `tool-policy-nag.json` (cwd copy first, then the one beside this
 * file) picks the detector, re-read at every watched call:
 *
 * - `{"detector": "heuristic"}` (also when no valid config exists): a command
 *   parser plus regexes. Ignoring the system prompt is one failure: after the
 *   first three hits, send at most three generic steer nags per context, then
 *   go quiet until a boundary that replaces the context (compaction, /clear,
 *   branch summary). Branch or tree navigation rebuilds the target branch's own
 *   state; it does not reset it.
 * - `{"detector": "jev", "judge": "<provider>/<model>", "threshold": 0.5}`:
 *   every watched call goes to a judgment-API model (Jev) as one request with
 *   one independent yes/no question per policy rule (SHELL_RULES / EVAL_RULES).
 *   Each call with a rule at or above `threshold` gets its own message listing
 *   every violated rule and the required tool; no counting, no cap. The verdict
 *   arrives after the call started, so the nag is an aside (a new turn when the
 *   session is already idle); a verdict that returns after a session move is
 *   only shown. A failed judge request warns once per reason and nags nothing;
 *   the heuristic is never a fallback.
 */

const NAG_TEXT = '你为什么不遵守system prompt。';
const STATE_ENTRY_TYPE = 'mouriya.omp.tool-policy-nag.state';
/** Fire on the hit that goes *past* three. */
const HIT_THRESHOLD = 3;
const MAX_NAGS_PER_CONTEXT = 3;
/**
 * Neither ExtensionContext nor the persisted session header exposes
 * AgentSession's internal agent kind: main files are `<timestamp>_<uuid>.jsonl`,
 * while subagents are `<parent>/<AgentName>.jsonl`. Use this path discriminator
 * instead of `ctx.mode`, because headless main `omp -p` is also `"print"`.
 */
const MAIN_SESSION_FILE_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const isMainSession = (ctx: ExtensionContext): boolean => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const fileName = sessionFile?.split(/[\\/]/).pop();
    return fileName !== undefined && MAIN_SESSION_FILE_PATTERN.test(fileName);
};

const runForMainSession = (ctx: ExtensionContext, handler: () => void): void => {
    if (isMainSession(ctx)) handler();
};

/** Programs that source file bytes the `read` tool owns. */
const READ_PROGRAMS: Record<string, true> = {
    cat: true,
    bat: true,
    nl: true,
    head: true,
    tail: true,
    less: true,
    more: true,
    sed: true,
};
const EVAL_PROGRAMS: Record<string, true> = {
    node: true,
    bun: true,
    deno: true,
    python: true,
    python3: true,
    ruby: true,
};
/**
 * Privilege elevation and remote execution: the command runs as another user or
 * on another host, where the built-in tools cannot reach, so it is never a hit.
 */
const EXEMPT_PROGRAMS: Record<string, true> = {
    sudo: true,
    doas: true,
    su: true,
    ssh: true,
};
/** Prefixes that delegate to the real program in the same command position. */
const WRAPPER_PROGRAMS: Record<string, true> = {
    command: true,
    env: true,
    time: true,
    nohup: true,
    builtin: true,
    exec: true,
    stdbuf: true,
    nice: true,
    xargs: true,
};

type NagState =
    | { readonly kind: 'watching'; readonly hits: number; readonly nagsSent: number }
    | { readonly kind: 'exhausted'; readonly hits: number; readonly nagsSent: number };

type ViolationCategory = 'list' | 'read' | 'search' | 'edit' | 'write' | 'eval';
type ShellProgram =
    | 'ls'
    | 'find'
    | 'cat'
    | 'bat'
    | 'nl'
    | 'head'
    | 'tail'
    | 'less'
    | 'more'
    | 'sed'
    | 'grep'
    | 'egrep'
    | 'fgrep'
    | 'rg'
    | 'ag'
    | 'ack'
    | 'awk'
    | 'perl'
    | 'mv'
    | 'echo'
    | 'printf'
    | 'node'
    | 'bun'
    | 'deno'
    | 'python'
    | 'python3'
    | 'ruby';
type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/** Library entry points the eval tool's `code` uses to reimplement `read`/`glob`. */
type EvalApi =
    | 'open'
    | 'Path.read_text'
    | 'Path.read_bytes'
    | 'readlines'
    | 'readFileSync'
    | 'fs.readFile'
    | 'Bun.file'
    | 'os.listdir'
    | 'os.scandir'
    | 'os.walk'
    | 'glob.glob'
    | 'Path.glob'
    | 'readdirSync'
    | 'fs.readdir'
    | 'Bun.Glob';

/** One shell command matched by one or more policy categories. */
export type ShellViolation = {
    readonly categories: NonEmptyReadonlyArray<ViolationCategory>;
    readonly program: ShellProgram | EvalApi;
    readonly target: string;
};

type RedirectOperator = 'write' | 'append' | 'hereDoc' | 'hereString' | 'other';
type CommandToken =
    | { readonly kind: 'word'; readonly text: string }
    /** `<` — the following word is a file the command reads. */
    | { readonly kind: 'readFrom'; readonly fd: number }
    /** `>`, `>>`, `2>`, `<<`, `<<<` — the following word is not a file being read. */
    | {
          readonly kind: 'otherRedirect';
          readonly operator: RedirectOperator;
          readonly fd: number;
      };

const isOperatorChar = (ch: string): boolean =>
    ch === '|' || ch === '&' || ch === ';' || ch === '\n' || ch === '(' || ch === ')' || ch === '`';

type HereDocument = { readonly delimiter: string; readonly stripTabs: boolean };

const skipHereDocument = (command: string, start: number, document: HereDocument): number => {
    let cursor = start;
    while (cursor < command.length) {
        const lineEnd = command.indexOf('\n', cursor);
        const end = lineEnd === -1 ? command.length : lineEnd;
        const line = command.slice(cursor, end);
        const comparable = document.stripTabs ? line.replace(/^\t+/, '') : line;
        if (comparable === document.delimiter) return lineEnd === -1 ? command.length : lineEnd + 1;
        if (lineEnd === -1) return command.length;
        cursor = lineEnd + 1;
    }
    return command.length;
};

/**
 * Splits a shell line into simple commands, keeping only what the detector needs:
 * command-position words, and whether a word is a redirection target. Quotes are
 * consumed (their content stays a single word), `$(`/backtick substitutions and
 * control operators end the current command, so `echo $(cat f)` still exposes
 * `cat f` as its own simple command. Here-document bodies are opaque.
 */
type SimpleCommand = { readonly tokens: CommandToken[]; readonly pipelineId: number };

function splitSimpleCommands(command: string): SimpleCommand[] {
    const commands: SimpleCommand[] = [];
    let current: CommandToken[] = [];
    let pipelineId = 0;
    let nextPipelineId = 1;
    let word = '';
    let wordStart: number | null = null;
    let wordCanBeFd = true;
    let quote: '"' | "'" | null = null;
    const substitutions: Array<{ readonly delimiter: '$(' | '`'; readonly resumeQuote: '"' | null }> = [];
    const suspendedCommands: Array<{ readonly current: CommandToken[]; readonly pipelineId: number }> = [];
    const hereDocuments: HereDocument[] = [];
    let expectingHereDocumentDelimiter: HereDocument | null = null;
    const flushWord = (): void => {
        if (word.length === 0) {
            wordStart = null;
            wordCanBeFd = true;
            return;
        }
        current.push({ kind: 'word', text: word });
        if (expectingHereDocumentDelimiter !== null) {
            hereDocuments.push({ delimiter: word, stripTabs: expectingHereDocumentDelimiter.stripTabs });
            expectingHereDocumentDelimiter = null;
        }
        word = '';
        wordStart = null;
        wordCanBeFd = true;
    };
    const flushCommand = (): void => {
        flushWord();
        if (current.length === 0) return;
        commands.push({ tokens: current, pipelineId });
        current = [];
    };
    const flushPipeline = (): void => {
        flushCommand();
        pipelineId = nextPipelineId++;
    };
    const beginSubstitution = (delimiter: '$(' | '`', resumeQuote: '"' | null): void => {
        flushWord();
        suspendedCommands.push({ current, pipelineId });
        current = [];
        pipelineId = nextPipelineId++;
        substitutions.push({ delimiter, resumeQuote });
    };
    const finishSubstitution = (): void => {
        flushCommand();
        const suspended = suspendedCommands.pop();
        current = suspended?.current ?? [];
        pipelineId = suspended?.pipelineId ?? 0;
        const substitution = substitutions.pop();
        quote = substitution?.resumeQuote ?? null;
    };

    for (let i = 0; i < command.length; i++) {
        const ch = command[i] as string;
        if (quote !== null) {
            if (ch === quote) {
                quote = null;
            } else if (quote === '"' && ch === '\\' && i + 1 < command.length) {
                word += command[i + 1] as string;
                i++;
            } else if (quote === '"' && ch === '$' && command[i + 1] === '(') {
                // A substitution inside double quotes still runs a command. Restore
                // the surrounding quote after its matching closing delimiter.
                beginSubstitution('$(', '"');
                quote = null;
                i++;
            } else if (quote === '"' && ch === '`') {
                beginSubstitution('`', '"');
                quote = null;
            } else {
                word += ch;
            }
            continue;
        }
        if (ch === '\\' && i + 1 < command.length) {
            if (wordStart === null) wordStart = i;
            wordCanBeFd = false;
            word += command[i + 1] as string;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            if (wordStart === null) wordStart = i;
            wordCanBeFd = false;
            quote = ch;
            continue;
        }
        if (ch === '$' && command[i + 1] === '(') {
            beginSubstitution('$(', null);
            i++;
            continue;
        }
        if (ch === '`') {
            const substitution = substitutions[substitutions.length - 1];
            if (substitution?.delimiter === '`') finishSubstitution();
            else beginSubstitution('`', null);
            continue;
        }
        if (ch === ')' && substitutions[substitutions.length - 1]?.delimiter === '$(') {
            finishSubstitution();
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\r') {
            flushWord();
            continue;
        }
        if (ch === '\n') {
            flushWord();
            if (hereDocuments.length > 0) {
                flushPipeline();
                let cursor = i + 1;
                for (const delimiter of hereDocuments) {
                    cursor = skipHereDocument(command, cursor, delimiter);
                }
                hereDocuments.length = 0;
                i = cursor - 1;
                continue;
            }
            flushPipeline();
            continue;
        }
        if (ch === '|') {
            if (command[i + 1] === '|') {
                flushPipeline();
                i++;
            } else if (command[i + 1] === '&') {
                flushCommand();
                i++;
            } else {
                flushCommand();
            }
            continue;
        }
        if (isOperatorChar(ch) && !(ch === '&' && command[i + 1] === '>')) {
            flushPipeline();
            continue;
        }
        if (ch === '<' || ch === '>') {
            let fdPrefix: number | null = null;
            if (
                wordCanBeFd &&
                wordStart !== null &&
                wordStart + word.length === i &&
                /^\d+$/.test(word)
            ) {
                fdPrefix = Number(word);
                word = '';
                wordStart = null;
                wordCanBeFd = true;
            } else {
                flushWord();
            }

            let operator: RedirectOperator;
            let consumed = 0;
            if (ch === '>') {
                if (command[i + 1] === '>') {
                    operator = 'append';
                    consumed = 1;
                } else if (command[i + 1] === '&') {
                    operator = 'other';
                    consumed = 1;
                } else {
                    operator = 'write';
                }
            } else if (command[i + 1] === '<' && command[i + 2] === '<') {
                operator = 'hereString';
                consumed = 2;
            } else if (command[i + 1] === '<') {
                operator = 'hereDoc';
                const stripTabs = command[i + 2] === '-';
                consumed = stripTabs ? 2 : 1;
                expectingHereDocumentDelimiter = { delimiter: '', stripTabs };
            } else if (command[i + 1] === '&') {
                operator = 'other';
                consumed = 1;
            } else {
                current.push({ kind: 'readFrom', fd: fdPrefix ?? 0 });
                continue;
            }
            current.push({
                kind: 'otherRedirect',
                operator,
                fd: fdPrefix ?? (ch === '>' ? 1 : 0),
            });
            i += consumed;
            continue;
        }
        if (wordStart === null) wordStart = i;
        word += ch;
    }
    flushPipeline();
    return commands;
}

const basename = (path: string): string => {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? path : path.slice(slash + 1);
};

const isEnvAssignment = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);

const isFlag = (text: string): boolean => text.length > 1 && text.startsWith('-');

const firstScriptOperand = (args: readonly string[]): string | undefined => {
    let options = true;
    for (const arg of args) {
        if (options && arg === '--') {
            options = false;
            continue;
        }
        if (options && isFlag(arg) && arg !== '-') continue;
        return arg;
    }
    return undefined;
};

type ParsedArguments = { readonly flags: readonly string[]; readonly operands: readonly string[] };

const parseArguments = (args: readonly string[], consumesValue: (flag: string) => boolean): ParsedArguments => {
    const flags: string[] = [];
    const operands: string[] = [];
    let options = true;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string;
        if (options && arg === '--') {
            options = false;
            continue;
        }
        if (options && isFlag(arg)) {
            flags.push(arg);
            if (consumesValue(arg)) i++;
            continue;
        }
        operands.push(arg);
    }
    return { flags, operands };
};

const optionName = (flag: string): string => {
    const equals = flag.indexOf('=');
    return equals === -1 ? flag : flag.slice(0, equals);
};

const noOptionValue = (_flag: string): boolean => false;

const readOptionConsumesValue = (program: string, flag: string): boolean => {
    const name = optionName(flag);
    if ((program === 'head' || program === 'tail') && (name === '-n' || name === '-c' || name === '--lines' || name === '--bytes')) {
        return flag === name;
    }
    if (program === 'nl' && (name === '-w' || name === '-s' || name === '-v' || name === '-i' || name === '--width' || name === '--separator' || name === '--starting-line-number' || name === '--line-increment')) {
        return flag === name;
    }
    return false;
};

const sedIsQuiet = (flags: readonly string[]): boolean =>
    flags.some(flag => flag === '--quiet' || flag === '--silent' || /^-[^-]*n/.test(flag));

const sedIsInPlace = (flags: readonly string[]): boolean =>
    flags.some(flag => flag === '--in-place' || flag.startsWith('--in-place=') || /^-[^-]*i/.test(flag));

/** With `-e`/`-f` the script is not an operand, so every operand is a file. */
const sedScriptIsFlag = (flags: readonly string[]): boolean =>
    flags.some(flag => {
        const name = optionName(flag);
        return name === '-e' || name === '-f' || name === '--expression' || name === '--file';
    });

const sedOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return (name === '-e' || name === '-f' || name === '--expression' || name === '--file') && flag === name;
};

const perlOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return (name === '-e' || name === '-f' || name === '--eval' || name === '--file') && flag === name;
};
const mvTarget = (args: readonly string[], operands: readonly string[]): string | undefined => {
    let targetDirectory: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i] as string;
        if (arg === '-t' || arg === '--target-directory') {
            targetDirectory = args[i + 1];
            i++;
        } else if (arg.startsWith('--target-directory=')) {
            targetDirectory = arg.slice('--target-directory='.length);
        } else if (arg.startsWith('-t') && arg.length > 2) {
            targetDirectory = arg.slice(2);
        }
    }
    if (targetDirectory !== undefined && operands.length > 0) return targetDirectory;
    if (operands.length < 2) return undefined;
    return lastNonDashOperand(operands);
};

const searchOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return (
        name === '-e' ||
        name === '-f' ||
        name === '--regexp' ||
        name === '--file' ||
        name === '--include' ||
        name === '--exclude' ||
        name === '--exclude-dir' ||
        name === '-g' ||
        name === '--glob' ||
        name === '--type' ||
        name === '--type-add'
    ) && flag === name;
};

const FIND_OPTIONS_WITH_VALUES: Record<string, true> = {
    '-D': true,
    '-maxdepth': true,
    '-mindepth': true,
    '-name': true,
    '-iname': true,
    '-path': true,
    '-ipath': true,
    '-wholename': true,
    '-iwholename': true,
    '-regex': true,
    '-iregex': true,
    '-type': true,
    '-user': true,
    '-group': true,
    '-perm': true,
    '-size': true,
    '-printf': true,
    '-fprintf': true,
};

const findOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return FIND_OPTIONS_WITH_VALUES[name] === true && flag === name;
};

const awkOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return (name === '-f' || name === '-v' || name === '-F') && flag === name;
};

const isSearchFlag = (flag: string): boolean => {
    if (flag === '--include' || flag.startsWith('--include=')) return true;
    if (flag.startsWith('--')) return false;
    return flag.slice(1).includes('r') || flag.slice(1).includes('R') || flag.slice(1).includes('l');
};

const firstNonDashOperand = (operands: readonly string[]): string | undefined =>
    operands.find(operand => operand !== '-');

const lastNonDashOperand = (operands: readonly string[]): string | undefined => {
    for (let i = operands.length - 1; i >= 0; i--) {
        const operand = operands[i] as string;
        if (operand !== '-' && operand.length > 0) return operand;
    }
    return undefined;
};


/** `/dev/*` is a kernel stream, not file bytes any tool can fetch. */
const isDeviceTarget = (target: string): boolean => target.startsWith('/dev/');

type OutputRedirect = { readonly operator: 'write' | 'append'; readonly target: string };

function analyzeSimpleCommand(tokens: readonly CommandToken[]): ShellViolation[] {
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index] as CommandToken;
        if (token.kind === 'readFrom' || token.kind === 'otherRedirect') {
            index += 2;
            continue;
        }
        if (token.kind !== 'word') return [];
        if (isEnvAssignment(token.text) || WRAPPER_PROGRAMS[basename(token.text)] === true) {
            index++;
            continue;
        }
        break;
    }
    const head = tokens[index];
    if (head === undefined || head.kind !== 'word') return [];
    const program = basename(head.text);
    if (EXEMPT_PROGRAMS[program] === true) return [];
    const args: string[] = [];
    const readInputs: string[] = [];
    const outputRedirects: OutputRedirect[] = [];
    for (let j = 0; j < tokens.length; j++) {
        const token = tokens[j] as CommandToken;
        if (token.kind === 'word') {
            if (j > index) args.push(token.text);
            continue;
        }
        const target = tokens[j + 1];
        if (target?.kind === 'word') {
            if (token.kind === 'readFrom' && token.fd === 0) {
                readInputs.push(target.text);
            } else if (
                token.kind === 'otherRedirect' &&
                token.fd === 1 &&
                !isDeviceTarget(target.text) &&
                (token.operator === 'write' ||
                    token.operator === 'append' ||
                    (token.operator === 'other' && !/^\d+$/.test(target.text) && target.text !== '-'))
            ) {
                outputRedirects.push({ operator: token.operator === 'append' ? 'append' : 'write', target: target.text });
            }
            j++;
        }
    }

    let categories: NonEmptyReadonlyArray<ViolationCategory> | null = null;
    let firstTarget: string | undefined;
    const addMatch = (category: ViolationCategory, target: string): void => {
        if (category !== 'list' && category !== 'eval' && isDeviceTarget(target)) return;
        firstTarget ??= target;
        if (categories === null) {
            categories = [category];
        } else if (!categories.includes(category)) {
            categories = [...categories, category];
        }
    };

    if (program === 'ls') {
        const parsed = parseArguments(args, noOptionValue);
        addMatch('list', firstNonDashOperand(parsed.operands) ?? '.');
    } else if (program === 'find') {
        const parsed = parseArguments(args, findOptionConsumesValue);
        const target = firstNonDashOperand(parsed.operands);
        if (target !== undefined) addMatch('list', target);
    }

    if (program === 'sed') {
        const parsed = parseArguments(args, sedOptionConsumesValue);
        if (sedIsInPlace(parsed.flags)) {
            const target = lastNonDashOperand(parsed.operands) ?? readInputs[0];
            if (target !== undefined) addMatch('edit', target);
        } else if (sedIsQuiet(parsed.flags)) {
            const fileOperands = sedScriptIsFlag(parsed.flags) ? parsed.operands : parsed.operands.slice(1);
            const target = firstNonDashOperand(fileOperands) ?? readInputs[0];
            if (target !== undefined) addMatch('read', target);
        }
    } else if (READ_PROGRAMS[program] === true) {
        const parsed = parseArguments(args, flag => readOptionConsumesValue(program, flag));
        const target = firstNonDashOperand(parsed.operands) ?? readInputs[0];
        if (target !== undefined) addMatch('read', target);
    }

    if (program === 'perl') {
        const parsed = parseArguments(args, perlOptionConsumesValue);
        const inPlace = parsed.flags.some(flag => flag === '--in-place' || flag.startsWith('--in-place=') || /^-[^-]*i/.test(flag));
        if (inPlace) {
            const target = lastNonDashOperand(parsed.operands) ?? readInputs[0];
            if (target !== undefined) addMatch('edit', target);
        }
    } else if (program === 'mv') {
        const parsed = parseArguments(args, () => false);
        const target = mvTarget(args, parsed.operands);
        if (target !== undefined) addMatch('edit', target);
    }

    if (
        program === 'grep' ||
        program === 'egrep' ||
        program === 'fgrep' ||
        program === 'rg' ||
        program === 'ag' ||
        program === 'ack'
    ) {
        const parsed = parseArguments(args, searchOptionConsumesValue);
        const hasSearchModeFlag = parsed.flags.some(isSearchFlag);
        const patternInOption = parsed.flags.some(flag => {
            const name = optionName(flag);
            return name === '-e' || name === '-f' || name === '--regexp' || name === '--file';
        });
        const fileOperand =
            parsed.operands.length > (patternInOption ? 0 : 1)
                ? parsed.operands[patternInOption ? 0 : 1]
                : readInputs[0];
        const target = fileOperand !== undefined && fileOperand !== '-' ? fileOperand : hasSearchModeFlag ? '.' : undefined;
        if (target !== undefined && (hasSearchModeFlag || readInputs.length > 0 || parsed.operands.length > (patternInOption ? 0 : 1))) {
            addMatch('search', target);
        }
    } else if (program === 'awk') {
        const parsed = parseArguments(args, awkOptionConsumesValue);
        const operands = parsed.operands.filter(operand => !isEnvAssignment(operand) && operand !== '-');
        const usesFileOption = parsed.flags.some(flag => optionName(flag) === '-f');
        const target = usesFileOption ? operands[0] : operands[1];
        if (target !== undefined) {
            addMatch('search', target);
        } else if (operands.length > 0 && readInputs[0] !== undefined) {
            addMatch('search', readInputs[0]);
        }
    }

    if (program === 'echo' || program === 'printf' || program === 'cat') {
        const redirect = outputRedirects[0];
        if (redirect !== undefined) addMatch('write', redirect.target);
    }

    if (EVAL_PROGRAMS[program] === true) {
        let target: string | null = null;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i] as string;
            if (arg === '-e' || arg === '-c' || arg === '--eval' || arg === '-p') {
                target = args[i + 1] ?? '<inline>';
                break;
            }
            if (arg.startsWith('--eval=')) {
                target = arg.slice('--eval='.length);
                break;
            }
            if (!arg.startsWith('--') && /^-[ecp].+/.test(arg)) {
                target = arg.slice(2);
                break;
            }
        }
        if (target === null && program === 'deno' && args[0] === 'eval') {
            target = firstScriptOperand(args.slice(1)) ?? '<inline>';
        }
        if (target === null && firstScriptOperand(args) === '-') target = '<stdin>';
        if (target !== null) addMatch('eval', target);
    }

    if (categories === null || firstTarget === undefined) return [];
    return [{ categories, program: program as ShellProgram, target: firstTarget }];
}

type CommandParts = {
    readonly program: string;
    readonly args: readonly string[];
    readonly hasInputRedirect: boolean;
};

const commandParts = (tokens: readonly CommandToken[]): CommandParts | null => {
    const words: string[] = [];
    let hasInputRedirect = false;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] as CommandToken;
        if (token.kind === 'word') {
            words.push(token.text);
            continue;
        }
        const target = tokens[i + 1];
        if (token.kind === 'readFrom' && token.fd === 0 && target?.kind === 'word') hasInputRedirect = true;
        if (target?.kind === 'word') i++;
    }

    let index = 0;
    while (index < words.length) {
        const word = words[index];
        if (word === undefined) return null;
        if (isEnvAssignment(word) || WRAPPER_PROGRAMS[basename(word)] === true) {
            index++;
            continue;
        }
        return { program: basename(word), args: words.slice(index + 1), hasInputRedirect };
    }
    return null;
};

const SORT_OPTIONS_WITH_VALUES: Record<string, true> = {
    '-k': true,
    '--key': true,
    '-t': true,
    '--field-separator': true,
    '-S': true,
    '--buffer-size': true,
    '-T': true,
    '--temporary-directory': true,
    '--compress-program': true,
    '--batch-size': true,
    '--parallel': true,
    '--files0-from': true,
};

const sortOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return SORT_OPTIONS_WITH_VALUES[name] === true && flag === name;
};

const UNIQ_OPTIONS_WITH_VALUES: Record<string, true> = {
    '-f': true,
    '--skip-fields': true,
    '-s': true,
    '--skip-chars': true,
    '-w': true,
    '--check-chars': true,
    '--group': true,
    '--all-repeated': true,
};

const uniqOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return UNIQ_OPTIONS_WITH_VALUES[name] === true && flag === name;
};

const WC_OPTIONS_WITH_VALUES: Record<string, true> = {
    '--files0-from': true,
};

const wcOptionConsumesValue = (flag: string): boolean => {
    const name = optionName(flag);
    return WC_OPTIONS_WITH_VALUES[name] === true && flag === name;
};

const isWcCommand = (tokens: readonly CommandToken[]): boolean => {
    const parts = commandParts(tokens);
    if (parts === null || parts.program !== 'wc' || parts.hasInputRedirect) return false;
    const parsed = parseArguments(parts.args, wcOptionConsumesValue);
    return firstNonDashOperand(parsed.operands) === undefined;
};

const isStreamReshaperWithoutFile = (tokens: readonly CommandToken[]): boolean => {
    const parts = commandParts(tokens);
    if (parts === null || parts.hasInputRedirect) return false;
    if (parts.program === 'tr') return true;
    if (parts.program === 'sort') return firstNonDashOperand(parseArguments(parts.args, sortOptionConsumesValue).operands) === undefined;
    if (parts.program === 'uniq') return firstNonDashOperand(parseArguments(parts.args, uniqOptionConsumesValue).operands) === undefined;
    if (parts.program === 'head' || parts.program === 'tail') {
        return firstNonDashOperand(parseArguments(parts.args, flag => readOptionConsumesValue(parts.program, flag)).operands) === undefined;
    }
    if (parts.program !== 'grep' && parts.program !== 'egrep' && parts.program !== 'fgrep' && parts.program !== 'rg' && parts.program !== 'ag' && parts.program !== 'ack') {
        return false;
    }
    const parsed = parseArguments(parts.args, searchOptionConsumesValue);
    const patternInOption = parsed.flags.some(flag => {
        const name = optionName(flag);
        return name === '-e' || name === '-f' || name === '--regexp' || name === '--file';
    });
    const fileOperands = parsed.operands.slice(patternInOption ? 0 : 1).filter(operand => operand !== '-');
    return fileOperands.length === 0;
};


const isCountExemptViolation = (violation: ShellViolation): boolean =>
    violation.categories.every(category => category === 'list' || category === 'read' || category === 'search');

/**
 * Walk backward over trailing stream reshapers to find the effective sink.
 * Only a `wc` sink makes read-only producers an allowed count pipeline.
 */
const countPipelineSinkIndex = (commands: readonly SimpleCommand[], lastIndex: number): number => {
    let index = lastIndex;
    while (index > 0) {
        const current = commands[index];
        const previous = commands[index - 1];
        if (
            current === undefined ||
            previous === undefined ||
            current.pipelineId !== previous.pipelineId ||
            !isStreamReshaperWithoutFile(current.tokens)
        ) {
            break;
        }
        index--;
    }
    return index;
};

/**
 * A terminal `wc` makes the preceding list/read/search producers part of an
 * allowed count pipeline. `ls -dt ... | head` remains a violation because the
 * glob contract makes `ls`'s newest-first ordering tool-covered; `head` is not
 * a counter.
 */
export function detectShellViolations(command: string): ShellViolation[] {
    const commands = splitSimpleCommands(command);
    const pipelineLast = new Map<number, number>();
    for (const [index, simple] of commands.entries()) pipelineLast.set(simple.pipelineId, index);

    const violations: ShellViolation[] = [];
    for (const [index, simple] of commands.entries()) {
        const commandViolations = analyzeSimpleCommand(simple.tokens);
        if (commandViolations.length === 0) continue;
        const lastIndex = pipelineLast.get(simple.pipelineId);
        const sinkIndex = lastIndex === undefined ? undefined : countPipelineSinkIndex(commands, lastIndex);
        const isCountPipelineProducer = sinkIndex !== undefined && sinkIndex > index && isWcCommand(commands[sinkIndex]?.tokens ?? []);
        if (isCountPipelineProducer) {
            violations.push(...commandViolations.filter(violation => !isCountExemptViolation(violation)));
        } else {
            violations.push(...commandViolations);
        }
    }
    return violations;
}

type UnknownRecord = { readonly [key: string]: unknown };

const stringField = (value: unknown, field: string): string | null => {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as UnknownRecord;
    const result = record[field];
    return typeof result === 'string' ? result : null;
};

const WRITE_DEVICE_COMMAND_FIELDS: Record<string, 'command' | 'cmd'> = {
    'xd://bash_bg': 'command',
    'xd://bash': 'command',
    'xd://exec_command': 'cmd',
};

/** A tool call whose shell command or eval code both detectors examine. */
type WatchedCall =
    | {
          readonly kind: 'shell';
          /** Tool name, or the write-device path the command was sent through. */
          readonly tool: string;
          readonly command: string;
          /** Only `exec_command` can allocate a PTY; `bash`/`bash_bg` never do. */
          readonly tty: boolean;
      }
    | { readonly kind: 'eval'; readonly language: string; readonly code: string };

/**
 * Extracts the shell command of a write-device payload. Device content is
 * untrusted JSON; malformed or non-shell payloads are intentionally ignored.
 */
function deviceShellCall(path: string, content: string): WatchedCall | null {
    const commandField = WRITE_DEVICE_COMMAND_FIELDS[path];
    if (commandField === undefined) return null;
    try {
        const payload: unknown = JSON.parse(content);
        const command = stringField(payload, commandField);
        if (command === null) return null;
        const tty = commandField === 'cmd' && typeof payload === 'object' && payload !== null && (payload as UnknownRecord).tty === true;
        return { kind: 'shell', tool: path, command, tty };
    } catch {
        return null;
    }
}

function watchedCallOf(toolName: string, input: unknown): WatchedCall | null {
    switch (toolName) {
        case 'bash':
        case 'bash_bg': {
            const command = stringField(input, 'command');
            return command === null ? null : { kind: 'shell', tool: toolName, command, tty: false };
        }
        case 'exec_command': {
            const command = stringField(input, 'cmd');
            const tty = typeof input === 'object' && input !== null && (input as UnknownRecord).tty === true;
            return command === null ? null : { kind: 'shell', tool: toolName, command, tty };
        }
        case 'write': {
            const path = stringField(input, 'path');
            const content = stringField(input, 'content');
            return path === null || content === null ? null : deviceShellCall(path, content);
        }
        case 'eval': {
            const language = stringField(input, 'language');
            const code = stringField(input, 'code');
            return language === null || code === null ? null : { kind: 'eval', language, code };
        }
        default:
            return null;
    }
}

type EvalLanguage = 'py' | 'js';
/** One library call the eval tool's `code` uses where a built-in tool exists. */
type EvalPattern = {
    readonly category: 'read' | 'list';
    readonly program: EvalApi;
    readonly test: RegExp;
};

/**
 * The eval tool's `code` is Python or JavaScript, not a shell line, so it needs
 * its own matchers. Only file reads (the `read` tool) and path/directory listing
 * (the `glob` tool) are flagged; writes, subprocesses, and in-memory work are
 * left alone. Patterns run in order and the first match per category names it.
 */
const EVAL_PATTERNS: Record<EvalLanguage, readonly EvalPattern[]> = {
    py: [
        { category: 'read', program: 'Path.read_text', test: /\.read_text\s*\(/ },
        { category: 'read', program: 'Path.read_bytes', test: /\.read_bytes\s*\(/ },
        { category: 'read', program: 'open', test: /\bopen\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*read/ },
        { category: 'read', program: 'open', test: /\bopen\s*\([^)]*,\s*['"]r[bt+]*['"]\s*\)/ },
        { category: 'read', program: 'open', test: /\bwith\s+open\s*\((?![^)]*['"][wax][bt+]*['"])[^)]*\)\s*as\b/ },
        { category: 'read', program: 'open', test: /\bfor\b[^\n]*\bin\s+open\s*\(/ },
        { category: 'read', program: 'readlines', test: /\.readlines\s*\(/ },
        { category: 'list', program: 'glob.glob', test: /\bglob\.i?glob\s*\(/ },
        { category: 'list', program: 'os.walk', test: /\bos\.walk\s*\(/ },
        { category: 'list', program: 'os.listdir', test: /\bos\.listdir\s*\(/ },
        { category: 'list', program: 'os.scandir', test: /\bos\.scandir\s*\(/ },
        { category: 'list', program: 'Path.glob', test: /\.\s*r?glob\s*\(/ },
    ],
    js: [
        { category: 'read', program: 'readFileSync', test: /\breadFileSync\s*\(/ },
        { category: 'read', program: 'fs.readFile', test: /\.\s*readFile\s*\(/ },
        { category: 'read', program: 'Bun.file', test: /\bBun\.file\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*(?:text|json|bytes|arrayBuffer|stream|formData)\s*\(/ },
        { category: 'list', program: 'readdirSync', test: /\breaddirSync\s*\(/ },
        { category: 'list', program: 'fs.readdir', test: /\.\s*readdir\s*\(/ },
        { category: 'list', program: 'Bun.Glob', test: /\bBun\.Glob\b|\bnew\s+Glob\s*\(/ },
    ],
};

const isEvalLanguage = (language: string): language is EvalLanguage =>
    language === 'py' || language === 'js';

/**
 * Flags eval-tool code that reimplements `read` (file bytes) or `glob`
 * (directory/path listing), at most one violation per category. Write,
 * subprocess, and pure in-memory work are intentionally ignored.
 */
export function detectEvalViolations(language: string, code: string): ShellViolation[] {
    if (!isEvalLanguage(language)) return [];
    const seen: Record<'read' | 'list', boolean> = { read: false, list: false };
    const violations: ShellViolation[] = [];
    for (const { category, program, test } of EVAL_PATTERNS[language]) {
        if (seen[category]) continue;
        const match = test.exec(code);
        if (match === null) continue;
        seen[category] = true;
        violations.push({ categories: [category], program, target: match[0].trim().slice(0, 60) });
    }
    return violations;
}

const WATCHING: NagState = { kind: 'watching', hits: 0, nagsSent: 0 };

function parseState(data: unknown): NagState | null {
    if (typeof data !== 'object' || data === null) return null;
    const record = data as Record<string, unknown>;
    if (record.kind !== 'watching' && record.kind !== 'exhausted') return null;
    if (
        typeof record.hits !== 'number' ||
        !Number.isFinite(record.hits) ||
        typeof record.nagsSent !== 'number' ||
        !Number.isFinite(record.nagsSent)
    ) {
        return null;
    }
    const hits = Math.max(0, Math.trunc(record.hits));
    const nagsSent = Math.max(0, Math.trunc(record.nagsSent));
    return record.kind === 'exhausted' ? { kind: 'exhausted', hits, nagsSent } : { kind: 'watching', hits, nagsSent };
}

/**
 * Rebuilds the counter from the session branch so a resumed process keeps its
 * word: a boundary that replaces the model's context (compaction, `/clear`,
 * a branch summary) discards every hit recorded before it.
 */
function rebuildState(ctx: ExtensionContext): NagState {
    let state: NagState = WATCHING;
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === 'compaction' || entry.type === 'reset_boundary' || entry.type === 'branch_summary') {
            state = WATCHING;
            continue;
        }
        if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY_TYPE) continue;
        const parsed = parseState(entry.data);
        if (parsed !== null) state = parsed;
    }
    return state;
}

// --- detector config (tool-policy-nag.json) ----------------------------------

const CONFIG_FILE = 'tool-policy-nag.json';
const JUDGE_TIMEOUT_MS = 90_000;

type JevDetector = {
    readonly kind: 'jev';
    readonly judge: { readonly provider: string; readonly modelId: string };
    /** A rule is violated when Jev's yes-probability reaches this value. */
    readonly threshold: number;
};
type Detector = { readonly kind: 'heuristic' } | JevDetector;

const HEURISTIC: Detector = { kind: 'heuristic' };

type ConfigParse = { readonly kind: 'ok'; readonly detector: Detector } | { readonly kind: 'invalid'; readonly reason: string };

function parseConfig(value: unknown): ConfigParse {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'invalid', reason: 'not a JSON object' };
    const record = value as UnknownRecord;
    switch (record.detector) {
        case 'heuristic':
            return { kind: 'ok', detector: HEURISTIC };
        case 'jev': {
            const judge = typeof record.judge === 'string' ? record.judge.trim() : '';
            const slash = judge.indexOf('/');
            if (slash <= 0 || slash === judge.length - 1) return { kind: 'invalid', reason: 'judge must be provider/model' };
            const threshold = record.threshold;
            if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) {
                return { kind: 'invalid', reason: 'threshold must be a number in (0, 1]' };
            }
            return {
                kind: 'ok',
                detector: { kind: 'jev', judge: { provider: judge.slice(0, slash), modelId: judge.slice(slash + 1) }, threshold },
            };
        }
        default:
            return { kind: 'invalid', reason: 'detector must be "heuristic" or "jev"' };
    }
}

/**
 * The caller's cwd copy first, then the one next to this file (lang-nag's
 * lookup). A missing or malformed candidate falls through to the next; when
 * neither is valid the heuristic detector runs.
 */
function loadDetector(cwd: string): { readonly detector: Detector; readonly warnings: readonly string[] } {
    const warnings: string[] = [];
    for (const path of [join(cwd, CONFIG_FILE), join(import.meta.dir, CONFIG_FILE)]) {
        if (!existsSync(path)) continue;
        let parsed: ConfigParse;
        try {
            parsed = parseConfig(JSON.parse(readFileSync(path, 'utf8')));
        } catch (error) {
            parsed = { kind: 'invalid', reason: `unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (parsed.kind === 'ok') return { detector: parsed.detector, warnings };
        warnings.push(`tool-policy-nag: 跳过 ${path}：${parsed.reason}`);
    }
    return { detector: HEURISTIC, warnings };
}

// --- Jev detector --------------------------------------------------------------

/** One operation the system prompt assigns to a built-in tool, asked as its own yes/no question. */
type PolicyRule = {
    readonly id: string;
    /** How the nag names the violation. */
    readonly label: string;
    /** The built-in tool the system prompt requires instead. */
    readonly tool: string;
    readonly question: string;
    readonly yes: string;
    readonly no: string;
};

const POLICY_PREAMBLE = [
    'The state is one tool call made by an AI coding agent. Its system prompt requires the built-in tools below and forbids reassembling the operations they cover through the shell or the eval kernel:',
    '`read` (file contents and line ranges, directory listings, archive members, SQLite databases, PDFs and documents, images, web URLs, remote files as `ssh://host/path`), `glob` (find files by name or pattern), `grep` (regex search over files), `edit` (modify an existing file; also renames and moves files), `write` (create or overwrite a file), `eval` (persistent Python/JS kernel for computation, data transforms, structured parsing, library calls), `ast_grep` / `ast_edit` (structural code search and rewrites), `exec_command` (shell commands; `tty: true` gives interactive programs a real terminal).',
    'The shell stays legitimate for real binaries and short fact pipelines: builds, tests, package managers, git, external CLIs and APIs, counts and checksums (`… | wc -l`, `sha256sum`), and anything run through `sudo` / `doas` / `su`.',
    'Answer only the question below about this one call; ignore every other aspect of it.',
].join('\n');

/** Asked about `bash` / `bash_bg` / `exec_command` commands; state `{ tool, command, tty }`. */
const SHELL_RULES: readonly PolicyRule[] = [
    {
        id: 'list',
        label: '用 shell 列目录 / 找文件',
        tool: '`read <dir>` / `glob`',
        question: 'Does this command list a directory or find files by name, path or pattern (`ls`, `find`, `fd`, `tree`, `ls -t | head`), an operation `read <dir>` or `glob` covers? A listing whose output only feeds a counter (`find … | wc -l`) does not count.',
        yes: 'The command lists directory entries or finds files that `read <dir>` or `glob` could return.',
        no: 'The command neither lists directories nor finds files, or only counts them.',
    },
    {
        id: 'read',
        label: '用 shell 读文件 / 归档 / 数据库 / 网页内容',
        tool: '`read`',
        question: 'Does this command fetch content `read` delivers: a file or a slice of it (`cat`, `head`, `tail`, `sed -n`, `less`, `bat`, `nl`, `awk \'{print}\'`, `< file`), an archive member (`unzip -p`, `tar -xO`), SQLite rows (`sqlite3 db \'SELECT …\'`), media metadata (`ffprobe`), or a web page or GitHub-hosted file viewed with `curl` / `wget`? Only commands whose purpose is printing that content count. Searching for matches (`grep`, `rg`, `awk \'/re/\'`) and changing files (`sed -i`) are judged by other rules and do not count here; neither do file bytes piped only into a counter or checksum, nor `curl` calls that drive an API, download artifacts or send data.',
        yes: 'The command prints file, archive, database, media or web content that `read` could return.',
        no: 'The command prints no such content: it searches, edits, counts or checksums, or uses curl for an API, download or upload.',
    },
    {
        id: 'search',
        label: '用 shell 搜索文件文本',
        tool: '`grep`',
        question: 'Does this command search file contents for text or a regex (`grep`, `rg`, `ag`, `ack`, `git grep` over files or directories; `awk` / `sed` / `perl` pattern matching over files), an operation the `grep` tool covers? Filtering another program\'s output stream (`cmd | grep x`) and counting matches do not count.',
        yes: 'The command searches the contents of files or directories.',
        no: 'The command searches no file contents, or only filters another program\'s output, or only counts matches.',
    },
    {
        id: 'edit',
        label: '用 shell 修改已有文件',
        tool: '`edit`',
        question: 'Does this command change an existing file in place (`sed -i`, `perl -pi`, `awk -i inplace`, `ed` / `ex` scripts, `>` / `>>` redirection or `tee` onto a file to alter it), an operation `edit` covers? Formatters, code generators, build tools, package managers and git operations that rewrite files as their own job do not count.',
        yes: 'The command alters an existing file\'s text itself.',
        no: 'The command alters no existing file, or a real tool rewrites files as its own job.',
    },
    {
        id: 'write',
        label: '用 shell 新建 / 覆盖文件',
        tool: '`write`',
        question: 'Does this command create or overwrite a file with content the agent itself authors (`echo` / `printf` / `cat <<EOF` redirected to a file, `tee file`, a heredoc into a file), an operation `write` covers? Redirecting a real program\'s output to a file (logs, build or test output, generated artifacts) does not count.',
        yes: 'The command writes agent-authored content to a file.',
        no: 'The command writes no agent-authored content to a file.',
    },
    {
        id: 'move',
        label: '用 shell 重命名 / 移动文件',
        tool: '`edit` 的 `MV`',
        question: 'Does this command rename or move a file or directory with `mv` (or `cp` followed by `rm`), an operation the `edit` tool\'s `MV` covers? `git mv` does not count.',
        yes: 'The command renames or moves a file or directory.',
        no: 'The command renames or moves nothing, or uses `git mv`.',
    },
    {
        id: 'inlineScript',
        label: '在 shell 里跑内联 Python / JS 脚本',
        tool: '`eval`',
        question: 'Does this command run inline script logic through the shell (`python3 - <<EOF`, `python -c`, `node -e`, `bun -e`, `deno eval`, `ruby -e`, `perl -e`, a heredoc or string piped into an interpreter), work the `eval` kernel covers? Running a script file that exists in the project (`python scripts/x.py`, `bun run build`, `bun test`) does not count.',
        yes: 'The command runs inline script code through an interpreter.',
        no: 'The command runs no inline script code.',
    },
    {
        id: 'structural',
        label: '用文本工具做结构化代码搜索 / 改写',
        tool: '`ast_grep` / `ast_edit`',
        question: 'Does this command search or rewrite code by syntax shape with text tools (regexes through `grep` / `sed` / `awk` / `perl` meant to match calls with their arguments, declarations, imports or multi-line constructs, or a codemod applied across files), work `ast_grep` / `ast_edit` cover? Searching for a literal identifier, string or log message does not count.',
        yes: 'The command matches or rewrites code structure with text patterns.',
        no: 'The command does no structural code matching or rewriting with text patterns.',
    },
    {
        id: 'pty',
        label: '交互程序没有走 PTY',
        tool: '`exec_command` 加 `tty: true`，再用 `write_stdin` 驱动',
        question: 'Does this command drive an interactive program without a real terminal: with `tty` false, an interactive `ssh` session, a password, passphrase or host-key prompt, `sudo` that will prompt, a REPL or database shell (`python`, `node`, `psql`, `mysql`, `redis-cli`), `docker exec -it` / `kubectl exec -it`, a TUI (`top`, `vim`, `less`), `git rebase -i` / `git add -p`, or an installer that asks questions; or a terminal faked with heredocs, `yes |`, `echo … |`, `expect`, `ssh -tt` or `script -q`? One-shot commands (`ssh host \'cmd\'`, `psql -c \'…\'`, `docker exec` without `-it`) do not count.',
        yes: 'The command runs an interactive program without a PTY, or fakes one.',
        no: 'The command runs no interactive program, or runs it with `tty` true, or is a one-shot.',
    },
];

/** Asked about `eval` code; state `{ tool, language, code }`. */
const EVAL_RULES: readonly PolicyRule[] = [
    {
        id: 'read',
        label: '在 eval 里读文件',
        tool: '`read`',
        question: 'Does this code read file contents from disk (`open(...).read()`, `Path.read_text` / `read_bytes`, `readlines`, `readFileSync`, `fs.readFile`, `Bun.file(...).text()` / `.json()`, the kernel\'s `read()` helper), content `read` delivers, including JSON through `?q=` jq filters and SQLite through selectors? Writing files and processing data already in memory do not count.',
        yes: 'The code reads file contents from disk.',
        no: 'The code reads no file contents.',
    },
    {
        id: 'list',
        label: '在 eval 里列目录 / 找文件',
        tool: '`read <dir>` / `glob`',
        question: 'Does this code list directories or find files (`os.listdir`, `os.scandir`, `os.walk`, `glob.glob`, `Path.glob` / `rglob`, `readdirSync`, `fs.readdir`, `Bun.Glob`), an operation `read <dir>` or `glob` covers?',
        yes: 'The code lists directories or finds files.',
        no: 'The code lists no directories and finds no files.',
    },
    {
        id: 'search',
        label: '在 eval 里搜索文件文本',
        tool: '`grep`',
        question: 'Does this code search file contents for text or a regex (reading files and matching patterns or substrings in them), an operation the `grep` tool covers?',
        yes: 'The code searches the contents of files.',
        no: 'The code searches no file contents.',
    },
    {
        id: 'edit',
        label: '在 eval 里改写并保存文件',
        tool: '`edit` / `write`',
        question: 'Does this code edit an existing file by reading it, changing the text and saving it back (rewrite-and-save, string replace then write), an operation `edit` covers? Writing new output files the computation produces does not count.',
        yes: 'The code rewrites an existing file\'s text and saves it.',
        no: 'The code rewrites no existing file.',
    },
    {
        id: 'subprocess',
        label: '在 eval 里跑 shell 命令或普通程序',
        tool: '`exec_command`（或覆盖该操作的内置工具）',
        question: 'Does this code start an operating-system process (`subprocess.run` / `Popen`, `os.system`, `!cmd`, `Bun.$`, `Bun.spawn`, `child_process`) such as `cat`, `ls`, `grep`, `rg`, `find`, `git`, builds or other programs that `exec_command` or another built-in tool runs directly? Calling the harness\'s own tools through `tool.<name>(…)` or `await tool.<name>(…)` starts no process and does not count.',
        yes: 'The code starts an operating-system process.',
        no: 'The code starts no operating-system process; calls to harness tools through `tool.<name>` do not count.',
    },
];

type JudgeResult =
    | { readonly kind: 'ok'; readonly probabilities: Readonly<Record<string, number>> }
    | { readonly kind: 'failed'; readonly reason: string };

/** One request, one independent yes/no question per rule: Jev answers each separately against the same call. */
async function judgeCall(ctx: ExtensionContext, detector: JevDetector, call: WatchedCall, rules: readonly PolicyRule[]): Promise<JudgeResult> {
    const { provider, modelId } = detector.judge;
    // Match by judgment API, not catalog kind (same lookup as turn-judge / watchdog-agent).
    const model = ctx.modelRegistry.getAvailable('all').find(candidate => candidate.provider === provider && candidate.id === modelId);
    if (!model) return { kind: 'failed', reason: `judge ${provider}/${modelId} not found` };
    if (!isJudgmentApi(model.api)) return { kind: 'failed', reason: `judge ${provider}/${modelId} has no judgment API (${model.api})` };
    const signal = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
    try {
        const sessionId = ctx.sessionManager.getSessionId();
        const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal });
        if (!apiKey) return { kind: 'failed', reason: 'judge credentials unavailable' };
        const headers = await ctx.modelRegistry.resolveModelHeaders(model, signal);
        const judge = new NativeJudge({
            apiKey: ctx.modelRegistry.resolver(model, sessionId),
            api: model.api,
            provider: model.provider,
            model: model.id,
            baseUrl: model.baseUrl,
            headers,
        });
        const questions: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }> = {};
        for (const rule of rules) {
            questions[rule.id] = { type: 'noul', instructions: `${POLICY_PREAMBLE}\n\nQuestion: ${rule.question}`, criteria: { true: rule.yes, false: rule.no } };
        }
        const state =
            call.kind === 'shell'
                ? { tool: call.tool, command: call.command, tty: call.tty }
                : { tool: 'eval', language: call.language, code: call.code };
        const result = await judge.judge({ state, questions }, { signal });
        const probabilities: Record<string, number> = {};
        for (const rule of rules) probabilities[rule.id] = result.answers[rule.id].noul;
        return { kind: 'ok', probabilities };
    } catch (error) {
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}

type Flagged = { readonly rule: PolicyRule; readonly probability: number };

/** A code fence longer than any backtick run inside `text`. */
function fenced(text: string, language: string): string {
    let longest = 2;
    for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
    const marks = '`'.repeat(longest + 1);
    return `${marks}${language}\n${text}\n${marks}`;
}

/** Every violation Jev found in the call, one line each, followed by the call itself. */
function jevNagText(call: WatchedCall, flagged: readonly Flagged[]): string {
    const tool = call.kind === 'shell' ? call.tool : 'eval';
    return [
        `你这次 \`${tool}\` 调用违反了 system prompt 的工具规则，共 ${flagged.length} 项：`,
        ...flagged.map(({ rule }, index) => `${index + 1}. ${rule.label}：应该用 ${rule.tool}`),
        '',
        '这次调用：',
        call.kind === 'shell' ? fenced(call.command, 'sh') : fenced(call.code, call.language),
    ].join('\n');
}

export default function toolPolicyNag(pi: ExtensionAPI): void {
    let state: NagState = WATCHING;
    const nestedDeviceCalls = new Set<string>();
    /** Bumped by every session move; a Jev verdict from an older epoch is shown, never sent. */
    let epoch = 0;
    /** Config and judge failures already reported, so a broken setup warns once per process. */
    const warned = new Set<string>();

    const commit = (next: NagState): void => {
        state = next;
        pi.appendEntry(STATE_ENTRY_TYPE, next);
    };

    const rearm = (reason: string): void => {
        if (state.kind === 'watching' && state.hits === 0 && state.nagsSent === 0) return;
        pi.logger.info('Tool-policy nag re-armed', { reason, previous: state });
        commit(WATCHING);
    };

    const restore = (reason: string, ctx: ExtensionContext): void => {
        epoch += 1;
        state = rebuildState(ctx);
        pi.logger.info('Tool-policy nag state restored', { reason, state });
    };

    const warnOnce = (ctx: ExtensionContext, text: string): void => {
        if (warned.has(text)) return;
        warned.add(text);
        pi.logger.warn(text);
        if (ctx.hasUI) ctx.ui.notify(text, 'warning');
    };

    const heuristicCheck = (ctx: ExtensionContext, call: WatchedCall): void => {
        if (state.kind === 'exhausted') return;
        const violations = call.kind === 'shell' ? detectShellViolations(call.command) : detectEvalViolations(call.language, call.code);
        if (violations.length === 0) return;

        // Every offending command counts, so four `cat`s batched into one bash
        // call are four hits rather than one.
        const hits = state.hits + violations.length;
        const programs = violations.map(violation => `${violation.program} ${violation.target}`);
        const violationDetails = violations.map(({ categories, program, target }) => ({ categories, program, target }));
        if (hits <= HIT_THRESHOLD) {
            pi.logger.info('Tool-policy violation observed', {
                hits,
                threshold: HIT_THRESHOLD,
                programs,
                violations: violationDetails,
                nagNumber: state.nagsSent,
                nagsSent: state.nagsSent,
                maxNags: MAX_NAGS_PER_CONTEXT,
                detectorArmed: true,
            });
            commit({ kind: 'watching', hits, nagsSent: state.nagsSent });
            return;
        }
        if (state.nagsSent >= MAX_NAGS_PER_CONTEXT) {
            commit({ kind: 'exhausted', hits, nagsSent: state.nagsSent });
            return;
        }
        const nagsSent = state.nagsSent + 1;
        const detectorArmed = nagsSent < MAX_NAGS_PER_CONTEXT;
        pi.logger.warn('Tool-policy violation past threshold — nagging', {
            hits,
            programs,
            violations: violationDetails,
            nagNumber: nagsSent,
            nagsSent,
            maxNags: MAX_NAGS_PER_CONTEXT,
            detectorArmed,
        });
        commit(
            detectorArmed
                ? { kind: 'watching', hits, nagsSent }
                : { kind: 'exhausted', hits, nagsSent },
        );
        pi.sendUserMessage(NAG_TEXT, { deliverAs: 'steer', attribution: 'agent' });
        ctx.ui.notify(
            `Shell policy nag ${nagsSent}/${MAX_NAGS_PER_CONTEXT} sent for hit #${hits} (${programs.join(', ')}) — detector ${
                detectorArmed ? 'still armed' : 'exhausted until compaction'
            }`,
            'warning',
        );
    };

    /** Runs beside the tool call; the verdict lands after it, so the nag goes out as an aside. */
    const jevCheck = async (ctx: ExtensionContext, detector: JevDetector, call: WatchedCall): Promise<void> => {
        const startedAt = epoch;
        const rules = call.kind === 'shell' ? SHELL_RULES : EVAL_RULES;
        const result = await judgeCall(ctx, detector, call, rules);
        switch (result.kind) {
            case 'failed':
                warnOnce(ctx, `tool-policy-nag: Jev 判断失败（${result.reason}）`);
                return;
            case 'ok':
                break;
            default: {
                const unreachable: never = result;
                return unreachable;
            }
        }
        const tool = call.kind === 'shell' ? call.tool : 'eval';
        const flagged: Flagged[] = [];
        for (const rule of rules) {
            const probability = result.probabilities[rule.id] ?? 0;
            if (probability >= detector.threshold) flagged.push({ rule, probability });
        }
        pi.logger.info('Tool-policy Jev verdict', {
            tool,
            threshold: detector.threshold,
            probabilities: result.probabilities,
            flagged: flagged.map(({ rule }) => rule.id),
        });
        if (flagged.length === 0) return;
        const summary = `tool-policy-nag Jev：${tool} 违规 ${flagged.map(({ rule, probability }) => `${rule.id} ${probability.toFixed(2)}`).join(' · ')}`;
        if (epoch !== startedAt) {
            if (ctx.hasUI) ctx.ui.notify(`${summary}；判断返回前会话已切换，未发送提醒`, 'info');
            return;
        }
        pi.sendUserMessage(jevNagText(call, flagged), ctx.isIdle() ? { attribution: 'agent' } : { deliverAs: 'aside', attribution: 'agent' });
        if (ctx.hasUI) ctx.ui.notify(summary, 'warning');
    };

    pi.on('session_start', (_event, ctx) => runForMainSession(ctx, () => restore('session_start', ctx)));
    pi.on('session_switch', (_event, ctx) => runForMainSession(ctx, () => restore('session_switch', ctx)));
    pi.on('session_branch', (_event, ctx) => runForMainSession(ctx, () => restore('session_branch', ctx)));
    pi.on('session_tree', (_event, ctx) => runForMainSession(ctx, () => restore('session_tree', ctx)));
    pi.on('session_compact', (_event, ctx) => runForMainSession(ctx, () => rearm('session_compact')));
    pi.on('auto_compaction_end', (event, ctx) =>
        runForMainSession(ctx, () => {
            if (event.aborted || event.skipped === true || event.result === undefined) return;
            rearm(`auto_compaction_end:${event.action}`);
        }),
    );

    pi.on('tool_call', (event, ctx) => runForMainSession(ctx, () => {
        if (event.toolName !== 'write' && nestedDeviceCalls.delete(event.toolCallId)) return;
        const call = watchedCallOf(event.toolName, event.input);
        if (call === null) return;
        // The device re-dispatches its payload as a nested tool call with the same id.
        if (event.toolName === 'write') nestedDeviceCalls.add(event.toolCallId);
        const { detector, warnings } = loadDetector(ctx.cwd);
        for (const warning of warnings) warnOnce(ctx, warning);
        switch (detector.kind) {
            case 'heuristic':
                heuristicCheck(ctx, call);
                return;
            case 'jev':
                void jevCheck(ctx, detector, call);
                return;
            default: {
                const unreachable: never = detector;
                return unreachable;
            }
        }
    }));
}
