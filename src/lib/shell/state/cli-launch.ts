import { ipc } from '$lib/ipc/client';
import { schemaStore } from '$lib/panels/state/schema-store.svelte';
import type { PendingFile, TabReport } from '$lib/ipc/bindings';

export interface CliIntent {
	schema: string | null;
	compareWith: string | null;
	waiting: boolean;
	// Where Save sends piped input back to the waiting terminal.
	reply: string | null;
}

const intents = new Map<string, CliIntent>();
const launches = new Map<string, PendingFile>();
const problems = new Map<string, string>();

export function rememberCliLaunch(tabId: string, file: PendingFile): void {
	launches.set(tabId, file);
	intents.set(tabId, {
		schema: file.schema,
		compareWith: file.compareWith,
		waiting: file.wait !== null,
		reply: file.reply,
	});
}

export function takeCliIntent(tabId: string): CliIntent | null {
	const intent = intents.get(tabId) ?? null;
	intents.delete(tabId);
	return intent;
}

export function noteCliProblem(tabId: string, message: string): void {
	if (launches.has(tabId)) problems.set(tabId, message);
}

function baseReport(file: PendingFile): TabReport {
	return {
		path: file.piped ? null : file.path,
		opened: true,
		saved: false,
		valid: null,
		errorCount: 0,
		errors: [],
		problem: null,
	};
}

// Piped input can be a secret, so its temp file goes with the tab.
export async function releaseCliTab(tabId: string, ctx: { saved: boolean } | null): Promise<void> {
	const file = launches.get(tabId);
	const problem = problems.get(tabId) ?? null;
	launches.delete(tabId);
	intents.delete(tabId);
	problems.delete(tabId);
	if (!file) return;
	const { result, error } = schemaStore.get(tabId);
	const report: TabReport = {
		...baseReport(file),
		opened: ctx !== null,
		saved: ctx?.saved ?? false,
		valid: result?.valid ?? null,
		errorCount: result?.errorCount ?? 0,
		errors: (result?.errors ?? []).map((e) => ({ pointer: e.instancePath, message: e.message })),
		problem: problem ?? error,
	};
	await settle(file, report);
}

export async function abandonCliLaunch(file: PendingFile, problem: string): Promise<void> {
	await settle(file, { ...baseReport(file), opened: false, problem });
}

async function settle(file: PendingFile, report: TabReport): Promise<void> {
	await Promise.all([
		file.wait ? ipc.cliWaitDone(file.wait, report).catch(() => {}) : null,
		file.piped ? ipc.cliDiscardPiped(file.path).catch(() => {}) : null,
	]);
}
