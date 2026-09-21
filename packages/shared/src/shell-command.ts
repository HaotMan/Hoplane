/**
 * Lightweight shell word scanner shared by the sudo gate and the policy
 * blacklist. It implements just enough POSIX shell lexical analysis — quote
 * removal, backslash escapes, assignment prefixes, the `time` wrapper and
 * command-substitution boundaries — so that security checks cannot be evaded
 * by splitting a keyword across quotes or escapes (`su''do`, `\sudo`,
 * `VAR=x sudo`). It is deliberately not a full shell parser: heredocs,
 * arithmetic expansion, parameter expansion and legacy backtick substitution
 * inside double quotes are treated as plain text.
 */

export interface ShellWord {
  /** Quote-removed, escape-resolved word text as the shell would see it. */
  text: string;
  /** Offset where the word starts in the original command (first quote or escape included). */
  start: number;
  /** Offset just past the word's last character in the original command. */
  end: number;
  /** True when the word occupies command position (start of a command, after prefix words). */
  atCommandPosition: boolean;
  /** True for assignment prefixes (`FOO=bar`), the `time` wrapper and `time -p`. */
  isPrefix: boolean;
}

const COMMAND_SEPARATORS = new Set([";", "&", "|", "(", ")", "{", "}", "`", "\n", "\r"]);
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/u;

type ScanMode = "plain" | "double-quote" | "substitution";

interface ScanState {
  modes: ScanMode[];
  words: ShellWord[];
  text: string;
  start: number;
  commandPosition: boolean;
  timeActive: boolean;
}

function flushWord(state: ScanState, end: number): void {
  if (state.text.length === 0) {
    state.start = -1;
    return;
  }
  const atCommandPosition = state.commandPosition;
  const isTimeFlag = state.timeActive && state.text === "-p";
  const isPrefix = atCommandPosition && (ASSIGNMENT_PREFIX.test(state.text) || state.text === "time" || isTimeFlag);
  if (isPrefix) {
    state.timeActive = state.text === "time";
  } else {
    state.timeActive = false;
    state.commandPosition = false;
  }
  state.words.push({ text: state.text, start: state.start, end, atCommandPosition, isPrefix });
  state.text = "";
  state.start = -1;
}

/**
 * Splits a command into shell words with quote removal applied. Words inside
 * double-quoted strings and after the first command word are returned with
 * `atCommandPosition: false`, so quoted text such as `echo "a && sudo b"` is
 * never mistaken for a command.
 */
export function scanShellWords(command: string): ShellWord[] {
  const state: ScanState = {
    modes: ["plain"], words: [], text: "", start: -1,
    commandPosition: true, timeActive: false
  };
  const mode = (): ScanMode => state.modes[state.modes.length - 1]!;
  const beginWord = (index: number): void => { if (state.start < 0) state.start = index; };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const current = mode();

    if (current === "double-quote") {
      if (char === '"') { state.modes.pop(); continue; }
      if (char === "\\" && (command[index + 1] === '"' || command[index + 1] === "\\" || command[index + 1] === "$")) {
        beginWord(index);
        const escaped = command[index + 1]!;
        state.text += escaped === "$" ? "\\$" : escaped;
        index += 1;
        continue;
      }
      if (char === "$" && command[index + 1] === "(") {
        // Command substitution inside double quotes still executes; open a real command context.
        flushWord(state, index);
        state.modes.push("substitution");
        state.commandPosition = true;
        state.timeActive = false;
        index += 1;
        continue;
      }
      beginWord(index);
      state.text += char;
      continue;
    }

    if (current === "substitution" && char === ")") {
      flushWord(state, index);
      state.modes.pop();
      // After the substitution closes we are back inside an argument word.
      state.commandPosition = false;
      state.timeActive = false;
      continue;
    }

    // Plain mode (top level or inside $()).
    if (char === "\\") {
      beginWord(index);
      const escaped = command[index + 1];
      state.text += escaped === undefined ? "\\" : escaped;
      if (escaped !== undefined) index += 1;
      continue;
    }
    if (char === "'") {
      beginWord(index);
      const end = command.indexOf("'", index + 1);
      const stop = end < 0 ? command.length : end;
      state.text += command.slice(index + 1, stop);
      index = stop;
      continue;
    }
    if (char === '"') { beginWord(index); state.modes.push("double-quote"); continue; }
    if (char === "$" && command[index + 1] === "(") {
      flushWord(state, index);
      state.modes.push("substitution");
      state.commandPosition = true;
      state.timeActive = false;
      index += 1;
      continue;
    }
    if (COMMAND_SEPARATORS.has(char)) {
      flushWord(state, index);
      state.commandPosition = true;
      state.timeActive = false;
      continue;
    }
    if (/\s/u.test(char)) { flushWord(state, index); continue; }
    beginWord(index);
    state.text += char;
  }
  flushWord(state, command.length);
  return state.words;
}

/**
 * Returns every substring a blacklist rule should be tested against besides
 * the raw command: one normalized string per command context. Each segment
 * has quote removal applied and leading assignment/`time` prefix words
 * dropped, so anchored rules such as `^\s*rm\s` match `r''m -rf /`,
 * `VAR=x rm -rf /` and `echo ok; rm -rf /` while still ignoring `echo 'rm'`.
 */
export function normalizedCommandSegments(command: string): string[] {
  const words = scanShellWords(command);
  const segments: ShellWord[][] = [];
  let current: ShellWord[] = [];
  let hasCommandWord = false;
  for (const word of words) {
    if (word.atCommandPosition && !word.isPrefix) {
      if (hasCommandWord) { segments.push(current); current = []; }
      hasCommandWord = true;
    }
    // Argument-position words only belong to a segment that already started;
    // stray ones (e.g. after a substitution closes) cannot start a command.
    if (word.atCommandPosition || current.length > 0) current.push(word);
  }
  if (current.length > 0) segments.push(current);
  return segments.map(joinWords).filter((segment) => segment.length > 0);
}

function joinWords(words: ShellWord[]): string {
  return words.filter((word) => !word.isPrefix).map((word) => word.text).join(" ");
}
