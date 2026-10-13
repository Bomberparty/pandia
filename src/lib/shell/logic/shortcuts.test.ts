import { describe, it, expect, vi } from 'vitest';
import { SHORTCUTS } from '$lib/ipc/bindings';
import { buildShellCommands, type ShellCommandDeps } from './app-commands';
import { createDocPaneCommands } from '$lib/docpane/logic/doc-pane-commands';
import type { DocPaneActions } from '$lib/docpane/logic/doc-actions';
import { matchShortcut, shortcutKeys } from './shortcuts';

vi.mock('$lib/util/platform', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/util/platform')>()),
	isMac: false,
}));

function key(code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return {
		code,
		ctrlKey: true,
		shiftKey: false,
		metaKey: false,
		altKey: false,
		...mods,
	} as KeyboardEvent;
}

describe('the shortcut table', () => {
	it('names a registered command in every row', () => {
		const ids = new Set(
			[
				...buildShellCommands({ isDev: false } as ShellCommandDeps),
				...createDocPaneCommands({} as DocPaneActions),
			].map((c) => c.id),
		);
		expect(SHORTCUTS.filter((s) => !ids.has(s.command)).map((s) => s.command)).toEqual([]);
	});

	it('uses each key combination once', () => {
		const combos = SHORTCUTS.map((s) => `${s.shift ? 'Shift+' : ''}${s.key}`);
		expect(new Set(combos).size).toBe(combos.length);
	});

	it('labels a command with its keys', () => {
		expect(shortcutKeys('doc.saveAs')).toBe('⌘⇧S');
		expect(shortcutKeys('tab.next')).toBe('⌘⇧]');
		expect(shortcutKeys('tree.expandAll')).toBeNull();
	});
});

describe('matchShortcut — Ctrl shortcuts off macOS', () => {
	it('finds the command for letter, digit and punctuation keys', () => {
		expect(matchShortcut(key('KeyS', { shiftKey: true }))).toBe('doc.saveAs');
		expect(matchShortcut(key('Digit2'))).toBe('view.code');
		expect(matchShortcut(key('BracketRight', { shiftKey: true }))).toBe('tab.next');
		expect(matchShortcut(key('Comma'))).toBe('nav.settings');
		expect(matchShortcut(key('Slash'))).toBe('help.shortcuts');
	});

	it('ignores keys without Ctrl, with Alt, or with no shortcut', () => {
		expect(matchShortcut(key('KeyS', { ctrlKey: false }))).toBeNull();
		expect(matchShortcut(key('KeyS', { altKey: true }))).toBeNull();
		expect(matchShortcut(key('KeyJ'))).toBeNull();
	});
});
