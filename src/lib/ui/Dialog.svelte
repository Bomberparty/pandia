<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		onClose: () => void;

		children: Snippet;
	}

	let { onClose, children }: Props = $props();

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}

	let pressedScrim = false;

	function onScrimClick(e: MouseEvent) {
		if (pressedScrim && e.target === e.currentTarget) onClose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div
	class="scrim"
	onmousedown={(e) => (pressedScrim = e.target === e.currentTarget)}
	onclick={onScrimClick}
	role="presentation"
>
	{@render children()}
</div>

<style>
	.scrim {
		position: fixed;
		inset: 0;
		background: var(--scrim);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
	}
</style>
