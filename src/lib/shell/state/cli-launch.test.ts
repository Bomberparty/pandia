import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipc } from '$lib/ipc/client';
import { schemaStore } from '$lib/panels/state/schema-store.svelte';
import type { PendingFile } from '$lib/ipc/bindings';
import { abandonCliLaunch, rememberCliLaunch, releaseCliTab, takeCliIntent } from './cli-launch';

vi.mock('$lib/ipc/client', () => ({
	ipc: { cliWaitDone: vi.fn(async () => {}), cliDiscardPiped: vi.fn(async () => {}) },
}));

function launched(extra: Partial<PendingFile>): PendingFile {
	return { path: '/w/a.json', piped: false, schema: null, compareWith: null, wait: null, ...extra };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('cli launch', () => {
	it('hands the schema and compare target to the tab once', () => {
		rememberCliLaunch('t1', launched({ schema: '/w/s.json', compareWith: '/w/b.json' }));
		expect(takeCliIntent('t1')).toEqual({ schema: '/w/s.json', compareWith: '/w/b.json' });
		expect(takeCliIntent('t1')).toBeNull();
	});

	it('tells the waiting terminal 0 when the tab closes clean, once', async () => {
		rememberCliLaunch('t2', launched({ wait: '/tmp/pandia-wait-1' }));
		await releaseCliTab('t2');
		await releaseCliTab('t2');
		expect(ipc.cliWaitDone).toHaveBeenCalledTimes(1);
		expect(ipc.cliWaitDone).toHaveBeenCalledWith('/tmp/pandia-wait-1', 0);
	});

	it('reports 1 when the Schema panel shows errors or the schema failed to load', async () => {
		rememberCliLaunch('t3', launched({ wait: '/tmp/pandia-wait-2' }));
		schemaStore.setResult(
			't3',
			{ valid: false, errors: [], errorCount: 2, truncated: false },
			null,
			1,
		);
		await releaseCliTab('t3');
		expect(ipc.cliWaitDone).toHaveBeenLastCalledWith('/tmp/pandia-wait-2', 1);

		rememberCliLaunch('t4', launched({ wait: '/tmp/pandia-wait-3' }));
		schemaStore.setResult('t4', null, "This schema can't be used.", null);
		await releaseCliTab('t4');
		expect(ipc.cliWaitDone).toHaveBeenLastCalledWith('/tmp/pandia-wait-3', 1);
	});

	it('deletes piped input when its tab closes', async () => {
		rememberCliLaunch('t5', launched({ piped: true, path: '/tmp/pandia-stdin-1.json' }));
		await releaseCliTab('t5');
		expect(ipc.cliDiscardPiped).toHaveBeenCalledWith('/tmp/pandia-stdin-1.json');
		expect(ipc.cliWaitDone).not.toHaveBeenCalled();
	});

	it('answers the wait and deletes piped input for a launch that never got a tab', async () => {
		await abandonCliLaunch(
			launched({ piped: true, path: '/tmp/pandia-stdin-2.json', wait: '/tmp/pandia-wait-4' }),
		);
		expect(ipc.cliWaitDone).toHaveBeenCalledWith('/tmp/pandia-wait-4', 1);
		expect(ipc.cliDiscardPiped).toHaveBeenCalledWith('/tmp/pandia-stdin-2.json');
	});

	it('ignores tabs that were not opened from the command line', async () => {
		await releaseCliTab('t9');
		expect(ipc.cliWaitDone).not.toHaveBeenCalled();
		expect(ipc.cliDiscardPiped).not.toHaveBeenCalled();
	});
});
