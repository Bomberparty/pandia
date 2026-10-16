// @vitest-environment jsdom
import { describe, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { ipc } from '$lib/ipc/client';
import type { DocContext } from '$lib/shell/state/workspace.svelte';
import OutlinePanel from './OutlinePanel.svelte';

vi.mock('$lib/ipc/client', () => ({ ipc: { docGetSlice: vi.fn() } }));

// jsdom has no ResizeObserver; the outline's scroller only needs observe/disconnect.
globalThis.ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

describe('OutlinePanel', () => {
	it('shows the document again after visiting an empty tab and coming back', async () => {
		vi.mocked(ipc.docGetSlice).mockResolvedValue([
			{ key: 'name', kind: 'string', preview: '"x"', childCount: null },
		]);
		const context = { handle: 'h1', version: 3 } as unknown as DocContext;
		const { findByText, rerender } = render(OutlinePanel, { props: { context } });
		await findByText('document');

		await rerender({ context: null });
		await rerender({ context });
		await findByText('document');
	});
});
