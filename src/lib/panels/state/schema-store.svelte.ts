import { ipc } from '$lib/ipc/client';
import { describeError } from '$lib/ipc/error-copy';
import type { DocHandle, SchemaValidationResult } from '$lib/ipc/bindings';
import type { SchemaFrom } from '../schema-ref';

export interface SchemaOrigin {
	from: SchemaFrom;
	ref: string;
	ignoredDocRef: string | null;
}

interface TabSchema {
	text: string;
	result: SchemaValidationResult | null;

	validatedVersion: number | null;
	busy: boolean;
	error: string | null;
	origin: SchemaOrigin | null;
}

const EMPTY: TabSchema = {
	text: '',
	result: null,
	validatedVersion: null,
	busy: false,
	error: null,
	origin: null,
};

class SchemaStore {
	private byTab: Record<string, TabSchema> = $state({});
	private seq: Record<string, number> = {};

	get(tabId: string): TabSchema {
		return this.byTab[tabId] ?? EMPTY;
	}

	setText(tabId: string, text: string, origin: SchemaOrigin | null = null): void {
		const prev = this.byTab[tabId] ?? EMPTY;
		this.byTab = { ...this.byTab, [tabId]: { ...prev, text, error: null, origin } };
	}

	setBusy(tabId: string, busy: boolean): void {
		const prev = this.byTab[tabId] ?? EMPTY;
		this.byTab = { ...this.byTab, [tabId]: { ...prev, busy } };
	}

	setResult(
		tabId: string,
		result: SchemaValidationResult | null,
		error: string | null,
		validatedVersion: number | null,
	): void {
		const prev = this.byTab[tabId] ?? EMPTY;
		this.byTab = {
			...this.byTab,
			[tabId]: { ...prev, result, error, validatedVersion, busy: false },
		};
	}

	async validate(tabId: string, handle: DocHandle, version: number): Promise<void> {
		const text = this.get(tabId).text.trim();
		if (!text) return;
		const mySeq = (this.seq[tabId] ?? 0) + 1;
		this.seq[tabId] = mySeq;
		this.setBusy(tabId, true);
		try {
			const result = await ipc.docValidateSchema(handle, text);
			if (this.seq[tabId] === mySeq) this.setResult(tabId, result, null, version);
		} catch (e) {
			if (this.seq[tabId] === mySeq) this.setResult(tabId, null, describeError(e), null);
		}
	}

	clear(tabId: string): void {
		delete this.seq[tabId];
		if (!(tabId in this.byTab)) return;
		const { [tabId]: _, ...rest } = this.byTab;
		this.byTab = rest;
	}
}

export const schemaStore = new SchemaStore();
