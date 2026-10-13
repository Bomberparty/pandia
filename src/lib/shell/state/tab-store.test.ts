import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipc } from '$lib/ipc/client';
import { schemaStore } from '$lib/panels/state/schema-store.svelte';
import type { PendingFile } from '$lib/ipc/bindings';
import { Handoff } from './handoff';
import { TabStore } from './tab-store.svelte';

vi.mock('$lib/ipc/client', () => ({
	ipc: {
		cliWaitDone: vi.fn(async () => {}),
		cliDiscardPiped: vi.fn(async () => {}),
		cliReply: vi.fn(async () => {}),
	},
}));

function waitingLaunch(path: string, wait: string): Handoff {
	const file: PendingFile = {
		path,
		piped: false,
		schema: null,
		compareWith: null,
		wait,
		reply: null,
	};
	return new Handoff(file);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('TabStore hand-offs', () => {
	it('settles a hand-off before clearing the tab’s schema state, so the report keeps its verdict', async () => {
		const tabs = new TabStore();
		const handoff = waitingLaunch('/w/a.json', '/tmp/pandia-wait-1');
		const id = tabs.openInTab({ kind: 'file', path: '/w/a.json' }, { handoff })!;
		handoff.opened();
		schemaStore.setResult(
			id,
			{ valid: false, errors: [], errorCount: 3, truncated: false },
			null,
			1,
		);

		tabs.close(id);
		await vi.waitFor(() => expect(ipc.cliWaitDone).toHaveBeenCalled());
		expect(vi.mocked(ipc.cliWaitDone).mock.calls[0]?.[1]).toMatchObject({
			valid: false,
			errorCount: 3,
		});
		expect(schemaStore.get(id).result).toBeNull();
	});

	it('never reuses a tab whose hand-off still owes a report', () => {
		const tabs = new TabStore();
		const first = tabs.openInTab(
			{ kind: 'file', path: '/w/missing.json' },
			{ handoff: waitingLaunch('/w/missing.json', '/tmp/pandia-wait-2') },
		);
		const second = tabs.openInTab({ kind: 'file', path: '/w/b.json' });
		expect(second).not.toBe(first);
	});

	it('reuses an empty tab whose hand-off owes nothing', () => {
		const tabs = new TabStore();
		const file: PendingFile = {
			path: '/w/a.json',
			piped: false,
			schema: '/w/s.json',
			compareWith: null,
			wait: null,
			reply: null,
		};
		const first = tabs.openInTab(
			{ kind: 'file', path: '/w/a.json' },
			{ handoff: new Handoff(file) },
		);
		const second = tabs.openInTab({ kind: 'file', path: '/w/b.json' });
		expect(second).toBe(first);
	});

	it('settles every tab’s hand-off when the window closes', async () => {
		const tabs = new TabStore();
		tabs.openInTab(
			{ kind: 'file', path: '/w/a.json' },
			{ handoff: waitingLaunch('/w/a.json', '/tmp/pandia-wait-3') },
		);
		tabs.openInTab(
			{ kind: 'file', path: '/w/b.json' },
			{ handoff: waitingLaunch('/w/b.json', '/tmp/pandia-wait-4') },
		);
		await tabs.settleAll();
		expect(ipc.cliWaitDone).toHaveBeenCalledTimes(2);
	});
});
