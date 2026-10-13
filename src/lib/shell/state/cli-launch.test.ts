import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipc } from '$lib/ipc/client';
import { schemaStore } from '$lib/panels/state/schema-store.svelte';
import type { PendingFile, TabReport } from '$lib/ipc/bindings';
import {
	abandonCliLaunch,
	noteCliProblem,
	rememberCliLaunch,
	releaseCliTab,
	takeCliIntent,
} from './cli-launch';

vi.mock('$lib/ipc/client', () => ({
	ipc: { cliWaitDone: vi.fn(async () => {}), cliDiscardPiped: vi.fn(async () => {}) },
}));

function launched(extra: Partial<PendingFile>): PendingFile {
	return {
		path: '/w/a.json',
		piped: false,
		schema: null,
		compareWith: null,
		wait: null,
		reply: null,
		...extra,
	};
}

function report(extra: Partial<TabReport>): TabReport {
	return {
		path: '/w/a.json',
		opened: true,
		saved: false,
		valid: null,
		errorCount: 0,
		errors: [],
		problem: null,
		...extra,
	};
}

const OPEN = { saved: false };

beforeEach(() => {
	vi.clearAllMocks();
});

describe('cli launch', () => {
	it('hands the tab its schema, compare target and reply file once', () => {
		rememberCliLaunch(
			't1',
			launched({ schema: '/w/s.json', compareWith: '/w/b.json', wait: '/tmp/pandia-wait-0' }),
		);
		expect(takeCliIntent('t1')).toEqual({
			schema: '/w/s.json',
			compareWith: '/w/b.json',
			waiting: true,
			reply: null,
		});
		expect(takeCliIntent('t1')).toBeNull();
	});

	it('reports a clean close, once', async () => {
		rememberCliLaunch('t2', launched({ wait: '/tmp/pandia-wait-1' }));
		await releaseCliTab('t2', { saved: true });
		await releaseCliTab('t2', { saved: true });
		expect(ipc.cliWaitDone).toHaveBeenCalledTimes(1);
		expect(ipc.cliWaitDone).toHaveBeenCalledWith('/tmp/pandia-wait-1', report({ saved: true }));
	});

	it('reports schema errors as JSON Pointers, and a schema that failed to load', async () => {
		rememberCliLaunch('t3', launched({ wait: '/tmp/pandia-wait-2' }));
		schemaStore.setResult(
			't3',
			{
				valid: false,
				errors: [
					{ instancePath: '/retries', schemaPath: '/properties', message: 'not an integer' },
				],
				errorCount: 1,
				truncated: false,
			},
			null,
			1,
		);
		await releaseCliTab('t3', OPEN);
		expect(ipc.cliWaitDone).toHaveBeenLastCalledWith(
			'/tmp/pandia-wait-2',
			report({
				valid: false,
				errorCount: 1,
				errors: [{ pointer: '/retries', message: 'not an integer' }],
			}),
		);

		rememberCliLaunch('t4', launched({ wait: '/tmp/pandia-wait-3' }));
		schemaStore.setResult('t4', null, "This schema can't be used.", null);
		await releaseCliTab('t4', OPEN);
		expect(ipc.cliWaitDone).toHaveBeenLastCalledWith(
			'/tmp/pandia-wait-3',
			report({ problem: "This schema can't be used." }),
		);
	});

	it('reports why a tab never loaded its file', async () => {
		rememberCliLaunch('t5', launched({ wait: '/tmp/pandia-wait-4' }));
		noteCliProblem('t5', 'Couldn’t open “a.json” — there’s no file at that path.');
		await releaseCliTab('t5', null);
		expect(ipc.cliWaitDone).toHaveBeenLastCalledWith(
			'/tmp/pandia-wait-4',
			report({ opened: false, problem: 'Couldn’t open “a.json” — there’s no file at that path.' }),
		);
	});

	it('reports piped input without a path and deletes it when its tab closes', async () => {
		rememberCliLaunch(
			't6',
			launched({ piped: true, path: '/tmp/pandia-stdin-1.json', wait: '/tmp/pandia-wait-5' }),
		);
		await releaseCliTab('t6', { saved: true });
		expect(ipc.cliDiscardPiped).toHaveBeenCalledWith('/tmp/pandia-stdin-1.json');
		expect(ipc.cliWaitDone).toHaveBeenCalledWith(
			'/tmp/pandia-wait-5',
			report({ path: null, saved: true }),
		);
	});

	it('answers the wait and deletes piped input for a launch that never got a tab', async () => {
		await abandonCliLaunch(
			launched({ piped: true, path: '/tmp/pandia-stdin-2.json', wait: '/tmp/pandia-wait-6' }),
			'Pandia already has 10 tabs open.',
		);
		expect(ipc.cliWaitDone).toHaveBeenCalledWith(
			'/tmp/pandia-wait-6',
			report({ path: null, opened: false, problem: 'Pandia already has 10 tabs open.' }),
		);
		expect(ipc.cliDiscardPiped).toHaveBeenCalledWith('/tmp/pandia-stdin-2.json');
	});

	it('ignores tabs that were not opened from the command line', async () => {
		await releaseCliTab('t9', OPEN);
		expect(ipc.cliWaitDone).not.toHaveBeenCalled();
		expect(ipc.cliDiscardPiped).not.toHaveBeenCalled();
	});
});
