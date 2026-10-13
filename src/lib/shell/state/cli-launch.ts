import { ipc } from '$lib/ipc/client';
import { schemaStore } from '$lib/panels/state/schema-store.svelte';
import type { PendingFile } from '$lib/ipc/bindings';

export interface CliIntent {
	schema: string | null;
	compareWith: string | null;
}

const intents = new Map<string, CliIntent>();
const waits = new Map<string, string>();
const pipedFiles = new Map<string, string>();

export function rememberCliLaunch(tabId: string, file: PendingFile): void {
	if (file.schema || file.compareWith) {
		intents.set(tabId, { schema: file.schema, compareWith: file.compareWith });
	}
	if (file.wait) waits.set(tabId, file.wait);
	if (file.piped) pipedFiles.set(tabId, file.path);
}

export function takeCliIntent(tabId: string): CliIntent | null {
	const intent = intents.get(tabId) ?? null;
	intents.delete(tabId);
	return intent;
}

// `pandia --wait` exits 1 when the Schema panel shows a problem as the tab closes. Piped input
// can be a secret, so its temp file goes with the tab.
export async function releaseCliTab(tabId: string): Promise<void> {
	const id = waits.get(tabId);
	const piped = pipedFiles.get(tabId);
	intents.delete(tabId);
	waits.delete(tabId);
	pipedFiles.delete(tabId);
	const { result, error } = schemaStore.get(tabId);
	const failed = error !== null || result?.valid === false;
	await Promise.all([
		id ? ipc.cliWaitDone(id, failed ? 1 : 0).catch(() => {}) : null,
		piped ? ipc.cliDiscardPiped(piped).catch(() => {}) : null,
	]);
}

export async function abandonCliLaunch(file: PendingFile): Promise<void> {
	await Promise.all([
		file.wait ? ipc.cliWaitDone(file.wait, 1).catch(() => {}) : null,
		file.piped ? ipc.cliDiscardPiped(file.path).catch(() => {}) : null,
	]);
}
