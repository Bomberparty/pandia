import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Op, Path } from '$lib/ipc/bindings';
import type { PromptController } from '$lib/ui/prompt.svelte';
import { createNodeActions, type CutMark } from './node-actions';
import type { ContentRow } from './model';

vi.mock('$lib/ipc/client', () => ({ ipc: {} }));

const TEXT = '{"id": 7}';

function setup(cutPath: Path) {
	const ops: Op[] = [];
	let cut: CutMark | null = { path: cutPath, text: TEXT };
	const setError = vi.fn();
	const actions = createNodeActions({
		handle: () => 'h' as never,
		rows: () => [],
		selectedIndex: () => -1,
		setSelectedPath: () => {},
		siblingCount: () => null,
		prompt: {} as PromptController,
		apply: async (op) => {
			ops.push(op);
			return { version: 1, affectedPaths: [] };
		},
		setError,
		flash: () => {},
		onOpenInNewTab: () => {},
		getCutMark: () => cut,
		setCutMark: (m) => (cut = m),
	});
	return { actions, ops, setError, cut: () => cut };
}

function row(path: Path): ContentRow {
	return { path, key: path[path.length - 1], depth: path.length } as ContentRow;
}

describe('paste after cut moves the value', () => {
	beforeEach(() => {
		vi.stubGlobal('navigator', { clipboard: { readText: async () => TEXT } });
	});

	it('moves an item down within its own array', async () => {
		const { actions, ops, cut } = setup(['list', 2]);
		await actions.paste(row(['list', 5]));
		expect(ops).toEqual([
			{ kind: 'insertItemText', path: ['list'], index: 6, text: TEXT },
			{ kind: 'deleteItem', path: ['list'], index: 2 },
		]);
		expect(cut()).toBeNull();
	});

	it('moves an item up within its own array, deleting the shifted original', async () => {
		const { actions, ops } = setup(['list', 5]);
		await actions.paste(row(['list', 1]));
		expect(ops).toEqual([
			{ kind: 'insertItemText', path: ['list'], index: 2, text: TEXT },
			{ kind: 'deleteItem', path: ['list'], index: 6 },
		]);
	});

	it('follows the cut value when the insert shifts one of its ancestors', async () => {
		const { actions, ops } = setup(['list', 1, 'items', 3]);
		await actions.paste(row(['list', 0]));
		expect(ops).toEqual([
			{ kind: 'insertItemText', path: ['list'], index: 1, text: TEXT },
			{ kind: 'deleteItem', path: ['list', 2, 'items'], index: 3 },
		]);
	});

	it('refuses to paste a cut value inside itself', async () => {
		const { actions, ops, setError } = setup(['list']);
		await actions.paste(row(['list', 0]));
		expect(ops).toEqual([]);
		expect(setError).toHaveBeenCalled();
	});
});
