// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render, within } from '@testing-library/svelte';
import { ipc } from '$lib/ipc/client';
import type { DiffEntry, Path } from '$lib/ipc/bindings';
import { reactiveBox } from '$lib/views/shared/test-runes.svelte';
import CompareView from './CompareView.svelte';

// jsdom has no layout, and CodeMirror measures text ranges after each change.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
globalThis.ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

vi.mock('$lib/ipc/client', () => ({
	ipc: {
		docDiff: vi.fn(),
		docCanonicalText: vi.fn(),
		docCanonicalOffsets: vi.fn(),
		docSummary: vi.fn(async () => ({ rootKind: 'array', rootChildCount: 0 })),
		docDiffLines: vi.fn(async () => ({ hunks: [], leftLines: 1, rightLines: 1 })),
	},
}));

let texts: Record<string, string> = {};
let entries: DiffEntry[] = [];

// Every test document is an array of one-letter strings, so element i spans [1 + 4i, 4 + 4i).
const props = {
	leftHandle: 'L' as never,
	rightHandle: 'R' as never,
	leftSourceSize: 20,
	rightSourceSize: 20,
	leftName: 'left.json',
	rightName: 'right.json',
	leftVersion: 1,
	rightVersion: 1,
};

function entry(e: Partial<DiffEntry> & Pick<DiffEntry, 'path' | 'kind'>): DiffEntry {
	return { leftPreview: null, rightPreview: null, fromIndex: null, ...e };
}

function pane(container: HTMLElement, side: 0 | 1): HTMLElement {
	return container.querySelectorAll<HTMLElement>('.split .pane')[side]!;
}

beforeEach(() => {
	vi.mocked(ipc.docDiff).mockImplementation(async () => entries);
	vi.mocked(ipc.docCanonicalText).mockImplementation(async (h) => texts[h] as never);
	vi.mocked(ipc.docCanonicalOffsets).mockImplementation(async (_h, paths: Path[]) =>
		paths.map((p) => ({ start: 1 + 4 * (p[0] as number), end: 4 + 4 * (p[0] as number) })),
	);
});

describe('CompareView — side-by-side', () => {
	it('outlines where a moved element came from in the left pane', async () => {
		texts = { L: '["a","b","c"]', R: '["b","c","a"]' };
		entries = [entry({ path: [2], kind: 'moved', fromIndex: 0, leftPreview: '"a"' })];
		const { container } = render(CompareView, { props });

		await vi.waitFor(() => {
			expect(pane(container, 0).querySelector('.cm-diff-active')?.textContent).toBe('"a"');
			expect(pane(container, 1).querySelector('.cm-diff-active')?.textContent).toBe('"a"');
		});
	});

	it('recomputes the diff and reloads each pane when its document changes', async () => {
		texts = { L: '["a"]', R: '["b"]' };
		entries = [entry({ path: [0], kind: 'changed' })];
		// Getters keep each version its own signal, as DocPane passes them.
		const left = reactiveBox(1);
		const right = reactiveBox(1);
		const { container } = render(CompareView, {
			props: {
				...props,
				get leftVersion() {
					return left.value;
				},
				get rightVersion() {
					return right.value;
				},
			},
		});
		const paneText = (side: 0 | 1) =>
			pane(container, side).querySelector('.cm-content')?.textContent;
		const listed = () => [...container.querySelectorAll('.entry .path')].map((e) => e.textContent);
		await vi.waitFor(() => expect(paneText(0)).toBe('["a"]'));
		expect(listed()).toEqual(['$[0]']);

		texts = { L: '["a","x"]', R: '["b"]' };
		entries = [entry({ path: [0], kind: 'changed' }), entry({ path: [1], kind: 'removed' })];
		left.value = 2;
		flushSync();
		await vi.waitFor(() => expect(listed()).toEqual(['$[0]', '$[1]']));
		await vi.waitFor(() => expect(paneText(0)).toBe('["a","x"]'));

		texts = { L: '["a","x"]', R: '["a","x"]' };
		entries = [];
		right.value = 2;
		flushSync();
		await vi.waitFor(() =>
			expect(container.querySelector('.entries')?.textContent).toContain('No differences'),
		);
		await vi.waitFor(() => expect(paneText(1)).toBe('["a","x"]'));
	});

	it('reloads the tree and inline layouts when a document changes', async () => {
		texts = { L: '[]', R: '[]' };
		entries = [];
		const left = reactiveBox(1);
		const { container } = render(CompareView, {
			props: {
				...props,
				get leftVersion() {
					return left.value;
				},
			},
		});
		const { getByText } = within(container);
		const leftSummaries = () => vi.mocked(ipc.docSummary).mock.calls.filter(([h]) => h === 'L');

		await fireEvent.click(getByText('Tree'));
		await vi.waitFor(() => expect(leftSummaries()).toHaveLength(1));
		left.value = 2;
		flushSync();
		await vi.waitFor(() => expect(leftSummaries()).toHaveLength(2));

		await fireEvent.click(getByText('Inline'));
		await vi.waitFor(() => expect(ipc.docDiffLines).toHaveBeenCalledTimes(1));
		left.value = 3;
		flushSync();
		await vi.waitFor(() => expect(ipc.docDiffLines).toHaveBeenCalledTimes(2));
	});
});
