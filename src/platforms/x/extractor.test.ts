import { describe, expect, test } from 'vitest';
import { parseHTML } from 'linkedom';

import { extractXStructuredContent, isXStatusUrl } from './extractor';

describe('X extractor', () => {
	test('accepts only X/Twitter status URLs', () => {
		expect(isXStatusUrl('https://x.com/example/status/123456')).toBe(true);
		expect(isXStatusUrl('https://twitter.com/example/status/123456')).toBe(true);
		expect(isXStatusUrl('https://x.com/example')).toBe(false);
		expect(isXStatusUrl('https://evilx.com/example/status/123456')).toBe(false);
	});

	test('extracts a text-only status fixture without a live API call', async () => {
		const pageUrl = 'https://x.com/example/status/123456';
		const { document } = parseHTML(`
			<html>
				<head><title>Example post / X</title></head>
				<body>
					<article>
						<a href="/example/status/123456"><time datetime="2026-07-25T00:00:00.000Z">Jul 25</time></a>
						<div data-testid="User-Name">Example User</div>
						<div data-testid="tweetText">First line<br>Second line</div>
					</article>
				</body>
			</html>
		`);

		const result = await extractXStructuredContent(document as unknown as Document, pageUrl);

		expect(result).not.toBeNull();
		expect(result?.author).toBe('example');
		expect(result?.published).toBe('2026-07-25T00:00:00.000Z');
		expect(result?.content).toContain('First line');
		expect(result?.content).toContain('Second line');
	});
});
