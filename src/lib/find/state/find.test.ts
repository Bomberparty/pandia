import { describe, it, expect, vi } from 'vitest';
import { FindController, type FindDeps } from './find.svelte';

vi.mock('$lib/ipc/client', () => ({ ipc: {} }));

function controller() {
	return new FindController({
		handle: () => null,
		canOpen: () => true,
		isCodeView: () => false,
		isGraphView: () => false,
		switchToTree: () => {},
		codeApi: () => null,
		openGraphSearch: () => {},
		navigateToHit: () => {},
		afterReplace: async () => {},
	} as FindDeps);
}

describe('FindController — find and replace', () => {
	it('Find leaves the replace field as it was', () => {
		const find = controller();
		find.openFind();
		expect(find.open).toBe(true);
		expect(find.replaceOpen).toBe(false);
	});

	it('Find and Replace opens the bar with the replace field showing', () => {
		const find = controller();
		find.openReplace();
		expect(find.open).toBe(true);
		expect(find.replaceOpen).toBe(true);
	});
});
