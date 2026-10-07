import { IpcError } from './error';
import type { FileOp, IoProblem } from './bindings';
import { fmtBytes } from '$lib/util/format';
import { basename, pathToString } from '$lib/util/path';

const FALLBACK = 'Something went wrong.';

const INTERNAL =
	'Something went wrong inside Pandia. Try again, and use Feedback to report it if it keeps happening.';

const VERB: Record<FileOp, string> = { open: 'open', save: 'save', export: 'export to' };

function sentence(s: string): string {
	return /[.!?]$/.test(s) ? s : `${s}.`;
}

function withDetail(lead: string, detail: string | undefined): string {
	return detail ? sentence(`${lead}: ${detail}`) : sentence(lead);
}

export function describeError(e: unknown): string {
	if (e instanceof IpcError) return describeIpc(e);
	if (e instanceof Error && e.message.trim()) return sentence(e.message.trim());
	if (typeof e === 'string' && e.trim()) return sentence(e.trim());
	return FALLBACK;
}

function describeIpc(e: IpcError): string {
	switch (e.kind) {
		case 'notFound':
			return 'This document is no longer open. Reopen the file and try again.';
		case 'invalidPath': {
			const where = e.path
				? `${pathToString(e.path)} no longer exists in this document`
				: 'That location no longer exists in this document';
			return `${where} — it may have been changed or removed by an earlier edit.`;
		}
		case 'tooLarge':
			return e.actual != null && e.limit != null
				? `This document is ${fmtBytes(e.actual)} — the limit for this action is ${fmtBytes(e.limit)}. Use a smaller file.`
				: 'This document is too large for this action. Use a smaller file.';
		case 'rangeTooLarge':
			return e.actual != null && e.limit != null
				? `Pandia requested ${e.actual} lines at once (the limit is ${e.limit}). This is a bug in Pandia, not a problem with your document.`
				: 'Pandia requested too many lines at once. This is a bug in Pandia, not a problem with your document.';
		case 'parse':
			return withDetail("This isn't valid JSON", e.detail);
		case 'edit':
			return withDetail("This edit can't be applied", e.detail);
		case 'schema':
			return withDetail("This schema can't be used", e.detail);
		case 'export':
			return withDetail('Export failed', e.detail);
		case 'io':
			return describeIo(e);
		case 'cancelled':
			return 'Cancelled.';
		default:
			return e.message.trim() ? sentence(e.message.trim()) : FALLBACK;
	}
}

function describeIo(e: IpcError): string {
	if (!e.io) return INTERNAL;
	const { problem, op, file } = e.io;
	const target = file ? `“${basename(file)}”` : 'a file';
	const lead = op ? `Couldn't ${VERB[op]} ${target}` : `Couldn't use ${target}`;
	const reason = ioReason(problem, op === 'save' || op === 'export');
	return reason ? `${lead} — ${reason}` : withDetail(lead, e.detail);
}

function ioReason(problem: IoProblem, writing: boolean): string | null {
	switch (problem) {
		case 'missing':
			return writing
				? 'the folder no longer exists. Choose another location.'
				: 'the file no longer exists. It may have been moved, renamed, or deleted.';
		case 'noPermission':
			return writing
				? "Pandia doesn't have permission to write there. Choose another location."
				: "Pandia doesn't have permission to read it.";
		case 'isFolder':
			return "it's a folder, not a file.";
		case 'notText':
			return "it isn't UTF-8 text, so it can't be read as JSON.";
		case 'diskFull':
			return 'the disk is full. Free up some space and try again.';
		case 'readOnly':
			return 'that location is read-only. Choose another location.';
		case 'other':
			return null;
	}
}
