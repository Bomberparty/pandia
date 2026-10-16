// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import { ipc } from '$lib/ipc/client';
import { schemaSessions } from '$lib/panels/state/schema-store.svelte';
import { Workspace, type TabSlot } from '$lib/shell/state/workspace.svelte';
import { PaneCommandBus } from '$lib/shell/state/pane-bus';
import { reactiveBox } from '$lib/views/shared/test-runes.svelte';
import DocPane from './DocPane.svelte';

vi.mock('$lib/ipc/client', () => ({
	ipc: {
		docOpen: vi.fn(),
		docSummary: vi.fn(),
		docDiff: vi.fn(async () => []),
		cancelJob: vi.fn(async () => true),
		docCanonicalText: vi.fn(async () => '[]'),
		docCanonicalOffsets: vi.fn(async () => []),
		docGetSlice: vi.fn(async () => []),
		docGetValue: vi.fn(async () => '"/w/order.schema.json"'),
		readSchemaFile: vi.fn(async () => '{"type":"object"}'),
		docValidateSchema: vi.fn(async () => ({
			valid: true,
			errors: [],
			errorCount: 0,
			truncated: false,
		})),
	},
}));
vi.mock('$lib/util/persist', async (original) => ({
	...(await original()),
	loadPersisted: vi.fn(async () => undefined),
	savePersisted: vi.fn(async () => {}),
}));

// jsdom has no ResizeObserver; the tree's scroller only needs observe/disconnect.
globalThis.ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};
// jsdom has no layout, and CodeMirror measures text ranges after each change.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const slot = {
	register: () => () => {},
	handoff: null,
	isHandleAlive: () => true,
	versionOf: () => null,
} as unknown as TabSlot;

describe('DocPane', () => {
	it('loads the $schema of pasted JSON, as it does for a file', async () => {
		vi.mocked(ipc.docOpen).mockResolvedValue({
			kind: 'opened',
			handle: 'h1' as never,
			summary: {
				rootKind: 'object',
				rootChildCount: 0,
				sourcePath: null,
				sourceSize: 40,
				lazy: false,
				version: 1,
				dirty: false,
				fileBacked: false,
				recoveryNote: null,
				commentsStripped: false,
			},
			notes: { convertedFrom: null, repairs: [] },
		});
		const { container } = render(DocPane, { props: { tabId: 'paste-tab', slot, isActive: false } });
		const box = container.querySelector('textarea.paste') as HTMLTextAreaElement;
		await fireEvent.input(box, { target: { value: '{"$schema": "/w/order.schema.json"}' } });
		await fireEvent.keyDown(box, { key: 'Enter', metaKey: true });

		await vi.waitFor(() => expect(container.querySelector('textarea.paste')).toBeNull());
		const schema = schemaSessions.for('paste-tab');
		await vi.waitFor(() => expect(schema.text).toBe('{"type":"object"}'));
		expect(schema.origin).toMatchObject({ from: 'document', ref: '/w/order.schema.json' });
	});

	it('recomputes a compare when the borrowed tab is edited', async () => {
		const summary = {
			rootKind: 'array' as const,
			rootChildCount: 0,
			sourcePath: '/w/a.json',
			sourceSize: 2,
			lazy: false,
			version: 1,
			dirty: false,
			fileBacked: true,
			recoveryNote: null,
			commentsStripped: false,
		};
		vi.mocked(ipc.docOpen).mockResolvedValue({
			kind: 'opened',
			handle: 'A' as never,
			summary,
			notes: { convertedFrom: null, repairs: [] },
		});
		vi.mocked(ipc.docSummary).mockResolvedValue(summary);
		const ws = new Workspace({
			confirmLargeFile: async () => true,
			confirmUnsaved: async () => 'discard',
		});
		const bVersion = reactiveBox(1);
		ws.register('tab-b', {
			label: 'b.json',
			sourceName: 'b.json',
			status: null,
			get context() {
				return {
					handle: 'B' as never,
					version: bVersion.value,
					sourceName: 'b.json',
					fileBacked: false,
					save: async () => true,
				};
			},
		});
		const paneBus = new PaneCommandBus();
		const { container } = render(DocPane, {
			props: {
				tabId: 'tab-a',
				slot: ws.slot('tab-a'),
				isActive: false,
				pendingOpen: { kind: 'file', path: '/w/a.json' },
				paneBus,
			},
		});
		await vi.waitFor(() => expect(container.querySelector('.view-modes')).not.toBeNull());

		paneBus.dispatch('tab-a', {
			kind: 'compare',
			target: { kind: 'tab', handle: 'B' as never, sourceName: 'b.json' },
		});
		await vi.waitFor(() => expect(ipc.docDiff).toHaveBeenCalledTimes(1));

		bVersion.value = 2;
		flushSync();
		await vi.waitFor(() => expect(ipc.docDiff).toHaveBeenCalledTimes(2));
	});
});
