import { describe, expect, test } from 'vitest';

import { buildObsidianOpenUrl } from './obsidian-note-creator';

describe('Obsidian open URL', () => {
	test('opens a Companion-written note in the selected vault', () => {
		expect(buildObsidianOpenUrl(
			'Clippings/OpenAI API Platform Documentation/00 - Documentation index.md',
			'My Vault'
		)).toBe(
			'obsidian://open?file=Clippings%2FOpenAI%20API%20Platform%20Documentation%2F00%20-%20Documentation%20index.md&vault=My%20Vault'
		);
	});

	test('normalizes Windows separators and allows the active vault fallback', () => {
		expect(buildObsidianOpenUrl('Docs\\Index.md', '')).toBe(
			'obsidian://open?file=Docs%2FIndex.md'
		);
	});
});
