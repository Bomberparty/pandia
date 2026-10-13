import { untrack } from 'svelte';
import { ipc } from '$lib/ipc/client';
import { describeError } from '$lib/ipc/error-copy';
import type { DocHandle, SchemaValidationResult } from '$lib/ipc/bindings';
import {
	behaviorPrefs,
	SCHEMA_DEBOUNCE_IMMEDIATE,
	SCHEMA_DEBOUNCE_MANUAL,
} from '$lib/settings/state/behavior-prefs.svelte';
import type { SchemaFrom } from '../schema-ref';

export interface SchemaOrigin {
	from: SchemaFrom;
	ref: string;
	ignoredDocRef: string | null;
}

/** The one answer a tab's schema gives about its document. */
export type SchemaVerdict =
	| { kind: 'none' }
	| { kind: 'checking'; last: SchemaValidationResult | null }
	| { kind: 'stale'; last: SchemaValidationResult | null }
	| { kind: 'checked'; result: SchemaValidationResult }
	| { kind: 'problem'; message: string };

/** The newest finished check, kept while a new one is pending so marks stay on screen. */
export function lastResult(verdict: SchemaVerdict): SchemaValidationResult | null {
	switch (verdict.kind) {
		case 'checked':
			return verdict.result;
		case 'checking':
		case 'stale':
			return verdict.last;
		default:
			return null;
	}
}

/** A tab's schema: its text, where it came from, and the verdict on the tab's document. */
export class SchemaSession {
	text = $state('');
	origin: SchemaOrigin | null = $state(null);
	verdict: SchemaVerdict = $state({ kind: 'none' });

	private doc: { handle: DocHandle; version: number } | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private seq = 0;

	// Called from the pane's effect; untracked so that effect doesn't depend on the verdict.
	documentChanged(handle: DocHandle, version: number): void {
		untrack(() => {
			const changed = this.doc !== null && this.doc.version !== version;
			this.doc = { handle, version };
			if (changed && this.verdict.kind !== 'none' && this.verdict.kind !== 'problem') {
				this.schedule();
			}
		});
	}

	setText(text: string): void {
		this.text = text;
		this.origin = null;
		this.schedule();
	}

	/** A schema arriving from --schema or $schema is checked at once unless checking is manual. */
	async load(text: string, origin: SchemaOrigin | null): Promise<void> {
		this.text = text;
		this.origin = origin;
		this.cancel();
		if (!text.trim()) {
			this.verdict = { kind: 'none' };
			return;
		}
		await behaviorPrefs.init();
		if (behaviorPrefs.schemaDebounceMs === SCHEMA_DEBOUNCE_MANUAL) {
			this.verdict = { kind: 'stale', last: null };
			return;
		}
		await this.validateNow();
	}

	fail(message: string, origin: SchemaOrigin | null): void {
		this.cancel();
		this.text = '';
		this.origin = origin;
		this.verdict = { kind: 'problem', message };
	}

	async validateNow(): Promise<void> {
		this.cancel();
		const text = this.text.trim();
		const doc = this.doc;
		if (!text || !doc) return;
		const mine = ++this.seq;
		this.verdict = { kind: 'checking', last: lastResult(this.verdict) };
		try {
			const result = await ipc.docValidateSchema(doc.handle, text);
			if (mine === this.seq) this.verdict = { kind: 'checked', result };
		} catch (e) {
			if (mine === this.seq) this.verdict = { kind: 'problem', message: describeError(e) };
		}
	}

	/** The verdict on the document as it is now, checking first if the last check is out of date. */
	async settleVerdict(): Promise<SchemaVerdict> {
		if (this.verdict.kind === 'checking' || this.verdict.kind === 'stale') {
			await this.validateNow();
		}
		return this.verdict;
	}

	clear(): void {
		this.cancel();
		this.seq++;
		this.text = '';
		this.origin = null;
		this.verdict = { kind: 'none' };
	}

	dispose(): void {
		this.cancel();
		this.seq++;
	}

	private schedule(): void {
		this.cancel();
		const last = lastResult(this.verdict);
		if (!this.text.trim()) {
			this.verdict = { kind: 'none' };
			return;
		}
		const ms = behaviorPrefs.schemaDebounceMs;
		if (ms === SCHEMA_DEBOUNCE_MANUAL) {
			this.verdict = { kind: 'stale', last };
			return;
		}
		this.seq++;
		this.verdict = { kind: 'checking', last };
		if (ms === SCHEMA_DEBOUNCE_IMMEDIATE) {
			void this.validateNow();
			return;
		}
		this.timer = setTimeout(() => void this.validateNow(), ms);
	}

	private cancel(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

class SchemaSessions {
	private byTab: Record<string, SchemaSession> = {};

	for(tabId: string): SchemaSession {
		return (this.byTab[tabId] ??= new SchemaSession());
	}

	existing(tabId: string): SchemaSession | null {
		return this.byTab[tabId] ?? null;
	}

	clear(tabId: string): void {
		this.byTab[tabId]?.dispose();
		delete this.byTab[tabId];
	}
}

export const schemaSessions = new SchemaSessions();
