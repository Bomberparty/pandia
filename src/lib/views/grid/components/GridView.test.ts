// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { render } from '@testing-library/svelte';
import { asLosslessText } from '$lib/ipc/wire';
import type { ColumnSchema } from '$lib/ipc/bindings';
import GridView from './GridView.svelte';

vi.mock('$lib/ipc/client', () => ({
	ipc: {
		docGetRows: vi.fn(async (_h: unknown, _p: unknown, start: number, end: number) =>
			Array.from({ length: end - start }, () => asLosslessText('{"a": 1}')),
		),
	},
}));

globalThis.ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

const VIEWPORT = 600;
// jsdom has no layout; give every element the grid's viewport height.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
	configurable: true,
	get: () => VIEWPORT,
});

// WebKit and Blink store layout sizes as an int32 count of 1/64 px (LayoutUnit),
// so a taller element is clamped and the rows past it can't be scrolled to.
const LAYOUT_MAX_PX = Math.floor(0x7fffffff / 64);

function schema(rowCount: number): ColumnSchema {
	return {
		gridSuitable: true,
		reason: null,
		rowCount,
		sampled: 0,
		columns: [
			{ key: 'a', kinds: ['number'], dominantKind: 'number', presence: null, nullable: false },
		],
	};
}

describe('GridView scrolling', () => {
	it.each([100, 2_000_000])(
		'scrolls to the last of %i rows within the layout limit',
		async (rowCount) => {
			const { container } = render(GridView, {
				props: { handle: 'doc', path: [], schema: schema(rowCount) },
			});
			const scroller = container.querySelector<HTMLElement>('.scroller')!;
			const content = container.querySelector<HTMLElement>('.content')!;
			const height = parseFloat(content.style.height);
			expect(height).toBeLessThanOrEqual(LAYOUT_MAX_PX);

			scroller.scrollTop = height - VIEWPORT;
			scroller.dispatchEvent(new Event('scroll'));
			flushSync();

			const lastIndex = () => container.querySelector<HTMLElement>('.index-cell:last-child');
			await vi.waitFor(() => expect(lastIndex()?.textContent).toBe(String(rowCount - 1)));
			const lastRow = [...content.querySelectorAll<HTMLElement>('.row')].at(-1)!;
			expect(parseFloat(lastRow.style.top) + parseFloat(lastRow.style.height)).toBeCloseTo(height);
			expect(lastIndex()!.style.top).toBe(lastRow.style.top);
		},
	);
});
