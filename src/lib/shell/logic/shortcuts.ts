import { SHORTCUTS } from '$lib/ipc/bindings';
import { fmtKbd, isMac } from '$lib/util/platform';

export type ShortcutCommand = (typeof SHORTCUTS)[number]['command'];

const PUNCTUATION_CODES: Record<string, string> = {
	',': 'Comma',
	'/': 'Slash',
	'[': 'BracketLeft',
	']': 'BracketRight',
};

function keyCode(key: string): string {
	if (/^[0-9]$/.test(key)) return `Digit${key}`;
	return PUNCTUATION_CODES[key] ?? `Key${key}`;
}

const combo = (shift: boolean, code: string) => (shift ? 'Shift+' : '') + code;

const COMMAND_BY_COMBO = new Map<string, string>(
	SHORTCUTS.map((s) => [combo(s.shift, keyCode(s.key)), s.command]),
);

const KEYS_BY_COMMAND = new Map<string, string>(
	SHORTCUTS.map((s) => [s.command, `⌘${s.shift ? '⇧' : ''}${s.key}`]),
);

export function matchShortcut(e: KeyboardEvent): string | null {
	if (isMac) return null;
	if (!e.ctrlKey || e.metaKey || e.altKey) return null;
	return COMMAND_BY_COMBO.get(combo(e.shiftKey, e.code)) ?? null;
}

export function shortcutKeys(command: string): string | null {
	return KEYS_BY_COMMAND.get(command) ?? null;
}

export function shortcutLabel(command: ShortcutCommand): string {
	return fmtKbd(KEYS_BY_COMMAND.get(command)!);
}
