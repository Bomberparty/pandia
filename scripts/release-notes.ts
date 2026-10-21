import { releases } from '../website/src/data/releases.ts';
import { toMarkdown } from '../src/lib/shell/logic/release-notes.ts';

const version = (process.argv[2] ?? '').replace(/^v/, '');
const release = releases.find((r) => r.version === version);
if (!release) {
	console.error(
		`No release notes for "${version}" in website/src/data/releases.ts. Add them before releasing.`,
	);
	process.exit(1);
}
console.log(toMarkdown(release));
