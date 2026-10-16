// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { fireEvent, render } from '@testing-library/svelte';
import Dialog from './Dialog.svelte';

function renderDialog() {
	const onClose = vi.fn();
	const children = createRawSnippet(() => ({ render: () => '<div><input /></div>' }));
	const { container } = render(Dialog, { props: { onClose, children } });
	return {
		onClose,
		input: container.querySelector('input')!,
		scrim: container.querySelector('.scrim')!,
	};
}

describe('Dialog — closing on the scrim', () => {
	it('stays open when a text selection is dragged out and released on the scrim', async () => {
		const { onClose, input, scrim } = renderDialog();
		await fireEvent.mouseDown(input);
		await fireEvent.click(scrim);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('closes when the scrim is clicked', async () => {
		const { onClose, scrim } = renderDialog();
		await fireEvent.mouseDown(scrim);
		await fireEvent.click(scrim);
		expect(onClose).toHaveBeenCalledOnce();
	});
});
