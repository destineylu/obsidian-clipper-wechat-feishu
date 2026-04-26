import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import {
	applyGitHubReadmeFallback,
	isGitHubMarkdownUrl,
	normalizeGitHubImageUrl,
} from './extractor';

const readmeUrl = 'https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts/blob/main/README.md';

describe('GitHub README extractor', () => {
	test('detects GitHub Markdown file pages', () => {
		expect(isGitHubMarkdownUrl(readmeUrl)).toBe(true);
		expect(isGitHubMarkdownUrl('https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts')).toBe(false);
		expect(isGitHubMarkdownUrl('https://example.com/owner/repo/blob/main/README.md')).toBe(false);
	});

	test('normalizes GitHub raw image URLs for Obsidian embeds', () => {
		expect(normalizeGitHubImageUrl('/EvoLinkAI/awesome-gpt-image-2-prompts/raw/main/images/logo.png', readmeUrl))
			.toBe('https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/logo.png');
		expect(normalizeGitHubImageUrl('https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts/raw/main/images/portrait_case1/output.jpg', readmeUrl))
			.toBe('https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/portrait_case1/output.jpg');
	});

	test('uses GitHub article HTML when generic extraction drops README images', () => {
		const { document } = parseHTML(`
			<html><body>
				<article class="markdown-body">
					<h1>README</h1>
					<p><img src="/EvoLinkAI/awesome-gpt-image-2-prompts/raw/main/images/logo.png" alt="Project logo"></p>
					<table><tbody><tr><td><img src="/EvoLinkAI/awesome-gpt-image-2-prompts/raw/main/images/portrait_case1/output.jpg" alt="Output image"></td></tr></tbody></table>
				</article>
			</body></html>
		`);

		const result = applyGitHubReadmeFallback(
			document as unknown as Document,
			{ content: '<h1>README</h1>' },
			readmeUrl
		);

		expect(result.content.match(/<img\b/g)).toHaveLength(2);
		expect(result.content).toContain('https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/logo.png');
		expect(result.content).toContain('https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/portrait_case1/output.jpg');
	});
});
