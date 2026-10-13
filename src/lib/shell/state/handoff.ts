import { ipc } from '$lib/ipc/client';
import { schemaStore } from '$lib/panels/state/schema-store.svelte';
import type { DocHandle, PendingFile, TabReport } from '$lib/ipc/bindings';

export interface HandoffInstructions {
	schema: string | null;
	compareWith: string | null;
}

export class Handoff {
	private instructions: HandoffInstructions | null;
	private wasOpened = false;
	private problem: string | null = null;
	private wasSaved = false;
	private settled = false;

	constructor(private readonly launch: PendingFile) {
		this.instructions =
			launch.schema || launch.compareWith
				? { schema: launch.schema, compareWith: launch.compareWith }
				: null;
	}

	static needed(file: PendingFile): boolean {
		return file.wait !== null || file.piped || file.schema !== null || file.compareWith !== null;
	}

	get waiting(): boolean {
		return this.launch.wait !== null;
	}

	get repliesToTerminal(): boolean {
		return this.launch.reply !== null;
	}

	get owes(): boolean {
		return !this.settled && (this.launch.wait !== null || this.launch.piped);
	}

	takeInstructions(): HandoffInstructions | null {
		const taken = this.instructions;
		this.instructions = null;
		return taken;
	}

	opened(): void {
		this.wasOpened = true;
		this.problem = null;
	}

	failed(problem: string): void {
		this.wasOpened = false;
		this.problem = problem;
	}

	recordSave(): void {
		this.wasSaved = true;
	}

	async sendBack(handle: DocHandle): Promise<void> {
		if (!this.launch.reply) return;
		await ipc.cliReply(handle, this.launch.reply);
		this.wasSaved = true;
	}

	async settle(tabId: string): Promise<void> {
		if (this.settled) return;
		const { result, error } = schemaStore.get(tabId);
		const problem =
			this.problem ??
			error ??
			(this.wasOpened ? null : 'The tab closed before the file finished opening.');
		await this.finish({
			...this.baseReport(),
			opened: this.wasOpened,
			saved: this.wasSaved,
			valid: result?.valid ?? null,
			errorCount: result?.errorCount ?? 0,
			errors: (result?.errors ?? []).map((e) => ({ pointer: e.instancePath, message: e.message })),
			problem,
		});
	}

	async abandon(problem: string): Promise<void> {
		if (this.settled) return;
		await this.finish({ ...this.baseReport(), problem });
	}

	private baseReport(): TabReport {
		return {
			path: this.launch.piped ? null : this.launch.path,
			opened: false,
			saved: false,
			valid: null,
			errorCount: 0,
			errors: [],
			problem: null,
		};
	}

	private async finish(report: TabReport): Promise<void> {
		this.settled = true;
		const { wait, piped, path } = this.launch;
		await Promise.all([
			wait ? ipc.cliWaitDone(wait, report).catch(() => {}) : null,
			piped ? ipc.cliDiscardPiped(path).catch(() => {}) : null,
		]);
	}
}
