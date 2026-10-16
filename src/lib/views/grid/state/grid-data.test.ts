// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { ipc } from '$lib/ipc/client';
import { asLosslessText } from '$lib/ipc/wire';
import { inRoot } from '$lib/views/shared/test-runes.svelte';
import { MISSING } from '../logic/grid-cell';
import { GridDataController } from './grid-data.svelte';

vi.mock('$lib/ipc/client', () => ({ ipc: { docGetRows: vi.fn() } }));

describe('GridDataController.getCell', () => {
	it('keeps an explicit null distinct from an absent key', async () => {
		vi.mocked(ipc.docGetRows).mockResolvedValue([
			asLosslessText('{"score": null}'),
			asLosslessText('{}'),
		]);
		const { result: data, destroy } = inRoot(
			() =>
				new GridDataController({
					handle: () => 'doc',
					path: () => [],
					rowCount: () => 2,
					query: () => ({
						sortKey: null,
						sortDesc: false,
						filterGroups: [],
						quick: '',
						quickKeys: [],
						filtering: false,
					}),
					onFilterOverflow: () => {},
					onError: () => {},
				}),
		);
		await data.fetchRange(0, 1);
		expect(data.getCell(0, 'score')).toBeNull();
		expect(data.getCell(1, 'score')).toBe(MISSING);
		destroy();
	});
});
