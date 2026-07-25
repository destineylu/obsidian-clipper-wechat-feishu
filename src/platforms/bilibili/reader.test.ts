import { describe, expect, test } from 'vitest';

import { isTrustedBilibiliPlayerMessage } from './reader';

describe('Bilibili Reader message validation', () => {
	test('requires both the exact iframe window and exact player origin', () => {
		const playerWindow = {} as WindowProxy;
		const otherWindow = {} as WindowProxy;

		expect(isTrustedBilibiliPlayerMessage({
			source: playerWindow,
			origin: 'https://player.bilibili.com',
		}, playerWindow)).toBe(true);

		expect(isTrustedBilibiliPlayerMessage({
			source: otherWindow,
			origin: 'https://player.bilibili.com',
		}, playerWindow)).toBe(false);

		expect(isTrustedBilibiliPlayerMessage({
			source: playerWindow,
			origin: 'https://evilbilibili.com',
		}, playerWindow)).toBe(false);
	});
});
