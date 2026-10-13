import { fetch } from '@tauri-apps/plugin-http';
import { ipc } from '$lib/ipc/client';
import { decodeLossless } from '$lib/ipc/wire';
import { describeError } from '$lib/ipc/error-copy';
import type { DocHandle } from '$lib/ipc/bindings';
import { behaviorPrefs, SCHEMA_DEBOUNCE_MANUAL } from '$lib/settings/state/behavior-prefs.svelte';
import { URL_FETCH_TIMEOUT_MS } from '$lib/shell/logic/url-fetch';
import { planSchema, type SchemaFrom, type SchemaTarget } from '../schema-ref';
import { schemaStore, type SchemaOrigin } from './schema-store.svelte';

const HTTP_BLOCKED =
	'Pandia only loads schemas over HTTPS. To load http:// URLs, turn on “Allow schemas over HTTP” in Settings → Behavior.';

// Approvals last for the session so restored tabs don't ask again; a refusal asks again next open.
const approvedUrls = new Set<string>();

export interface OpenedDoc {
	tabId: string;
	handle: DocHandle;
	version: number;
	path: string | null;
	rootIsObject: boolean;
	cliSchema: string | null;
}

export async function autoloadSchema(
	doc: OpenedDoc,
	confirmRemote: (host: string) => Promise<boolean>,
): Promise<void> {
	const docRef = doc.rootIsObject ? await readDocSchemaRef(doc.handle) : null;
	const plan = planSchema({ cliRef: doc.cliSchema, docRef, docPath: doc.path });
	if (plan.kind === 'none') return;

	const origin: SchemaOrigin = {
		from: plan.from,
		ref: plan.ref,
		ignoredDocRef: plan.kind === 'load' ? plan.ignoredDocRef : null,
	};
	const fail = (message: string) => {
		schemaStore.setText(doc.tabId, '', origin);
		schemaStore.setResult(doc.tabId, null, message, null);
	};
	if (plan.kind === 'invalid') return fail(plan.message);
	let text: string | null;
	try {
		text = await readTarget(plan.target, plan.from, confirmRemote);
	} catch (e) {
		return fail(describeError(e));
	}
	schemaStore.setText(doc.tabId, text ?? '', origin);
	if (text === null) return;

	await behaviorPrefs.init();
	if (behaviorPrefs.schemaDebounceMs !== SCHEMA_DEBOUNCE_MANUAL) {
		await schemaStore.validate(doc.tabId, doc.handle, doc.version);
	}
}

async function readDocSchemaRef(handle: DocHandle): Promise<string | null> {
	try {
		const value = decodeLossless(await ipc.docGetValue(handle, ['$schema']));
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}

async function readTarget(
	target: SchemaTarget,
	from: SchemaFrom,
	confirmRemote: (host: string) => Promise<boolean>,
): Promise<string | null> {
	if (target.kind === 'file') return ipc.readSchemaFile(target.path);
	await behaviorPrefs.init();
	if (!target.secure && !behaviorPrefs.allowHttpSchemas) throw new Error(HTTP_BLOCKED);
	if (from === 'document' && !approvedUrls.has(target.url)) {
		if (!(await confirmRemote(target.host))) return null;
		approvedUrls.add(target.url);
	}
	return download(target.url, target.host);
}

async function download(url: string, host: string): Promise<string> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(url, { signal: ctrl.signal });
	} catch {
		throw new Error(
			`Couldn't reach ${host} to download the schema. Check your connection and the URL.`,
		);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		throw new Error(
			`Couldn't download the schema from ${host}: the server answered ${res.status}. Check the URL.`,
		);
	}
	return res.text();
}
