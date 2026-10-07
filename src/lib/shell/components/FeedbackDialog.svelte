<script lang="ts">
	import Dialog from '$lib/ui/Dialog.svelte';

	interface Props {
		onShare: () => void;
		onClose: () => void;
	}
	let { onShare, onClose }: Props = $props();

	let shareBtn: HTMLButtonElement | undefined = $state();
	$effect(() => {
		const t = setTimeout(() => shareBtn?.focus(), 0);
		return () => clearTimeout(t);
	});
</script>

<Dialog {onClose}>
	<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
		<div class="title" id="feedback-title">Feedback</div>
		<p class="dim text-sm msg">
			We'd love your feedback — ideas, missing features, rough edges. It opens a short form in your
			browser.
		</p>
		<div class="actions">
			<button class="btn" onclick={onClose}>maybe later<span class="hint">esc</span></button>
			<button bind:this={shareBtn} class="btn btn-primary" onclick={onShare}
				>Share feedback ↗<span class="hint">↵</span></button
			>
		</div>
	</div>
</Dialog>

<style>
	.sheet {
		background: var(--bg-elev);
		border: var(--rule-width) solid var(--rule);
		min-width: 380px;
		max-width: 460px;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.9rem 1rem;
		box-shadow: 0 12px 36px rgba(0, 0, 0, 0.7);
	}
	.title {
		color: var(--text);
		font-size: var(--font-size-sm);
		text-transform: uppercase;
		letter-spacing: var(--label-tracking);
	}
	.msg {
		margin: 0;
		line-height: 1.55;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.4rem;
		margin-top: 0.2rem;
	}
	.hint {
		color: var(--text-faint);
		margin-left: 0.4rem;
	}
	.btn-primary .hint {
		color: var(--bg);
		opacity: 0.6;
	}
	.btn-primary:hover .hint {
		color: var(--accent);
	}
</style>
