import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';
import {
	applyGitHubReadmeFallback,
	isGitHubMarkdownUrl,
	isGitHubReadmeUrl,
	isGitHubUrl,
	normalizeGitHubImageUrl,
} from './extractor';

const readmeUrl = 'https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts/blob/main/README.md';
const repoUrl = 'https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts';

describe('GitHub README extractor', () => {
	test('detects GitHub Markdown file pages', () => {
		expect(isGitHubMarkdownUrl(readmeUrl)).toBe(true);
		expect(isGitHubMarkdownUrl(repoUrl)).toBe(false);
		expect(isGitHubMarkdownUrl('https://example.com/owner/repo/blob/main/README.md')).toBe(false);
	});

	test('detects GitHub repository README pages', () => {
		expect(isGitHubReadmeUrl(readmeUrl)).toBe(true);
		expect(isGitHubReadmeUrl(repoUrl)).toBe(true);
		expect(isGitHubReadmeUrl(`${repoUrl}/tree/main`)).toBe(true);
		expect(isGitHubReadmeUrl('https://github.com/EvoLinkAI')).toBe(false);
		expect(isGitHubReadmeUrl('https://example.com/owner/repo')).toBe(false);
	});

	test('detects generic GitHub pages for markdown-body fallback', () => {
		expect(isGitHubUrl(`${repoUrl}/issues/1`)).toBe(true);
		expect(isGitHubUrl(`${repoUrl}/pull/1`)).toBe(true);
		expect(isGitHubUrl('https://gist.github.com/EvoLinkAI/abc')).toBe(false);
		expect(isGitHubUrl('https://example.com/owner/repo/issues/1')).toBe(false);
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
			repoUrl
		);

		expect(result.content.match(/<img\b/g)).toHaveLength(2);
		expect(result.content).toContain('https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/logo.png');
		expect(result.content).toContain('https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/portrait_case1/output.jpg');
	});

	test('uses GitHub markdown-body fallback on issue-like pages', () => {
		const issueUrl = `${repoUrl}/issues/1`;
		const { document } = parseHTML(`
			<html><body>
				<div class="markdown-body">
					<p><img src="/EvoLinkAI/awesome-gpt-image-2-prompts/raw/main/images/issue.png" alt="Issue image"></p>
				</div>
			</body></html>
		`);

		const result = applyGitHubReadmeFallback(
			document as unknown as Document,
			{ content: '<p>Issue body</p>' },
			issueUrl
		);

		expect(result.content.match(/<img\b/g)).toHaveLength(1);
		expect(result.content).toContain('https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-prompts/main/images/issue.png');
	});
});
