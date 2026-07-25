import { describe, expect, test, vi } from 'vitest';

import {
	isBilibiliHostname,
	setBilibiliEmbedRuleForTab,
} from './background';

function createDnr(initialTabIds: number[] = []) {
	let rules: Array<{ id: number; condition: { tabIds: number[] } }> = initialTabIds.length
		? [{ id: 91_002, condition: { tabIds: [...initialTabIds] } }]
		: [];

	return {
		getSessionRules: vi.fn(async () => rules),
		updateSessionRules: vi.fn(async (update: { removeRuleIds: number[]; addRules?: any[] }) => {
			rules = rules.filter(rule => !update.removeRuleIds.includes(rule.id));
			if (update.addRules) {
				rules.push(...update.addRules);
			}
		}),
		currentTabIds: () => rules.find(rule => rule.id === 91_002)?.condition.tabIds || [],
	};
}

describe('Bilibili background rules', () => {
	test('keeps independent Reader tabs in one session rule', async () => {
		const dnr = createDnr();

		await Promise.all([
			setBilibiliEmbedRuleForTab(11, true, dnr),
			setBilibiliEmbedRuleForTab(22, true, dnr),
		]);
		expect(dnr.currentTabIds()).toEqual([11, 22]);

		await setBilibiliEmbedRuleForTab(11, false, dnr);
		expect(dnr.currentTabIds()).toEqual([22]);
	});

	test('removes the rule only when the final Reader tab closes', async () => {
		const dnr = createDnr([31]);

		await setBilibiliEmbedRuleForTab(31, false, dnr);

		expect(dnr.currentTabIds()).toEqual([]);
		expect(dnr.updateSessionRules).toHaveBeenLastCalledWith({
			removeRuleIds: [91_002],
		});
	});

	test('does not accept suffix-confusion hostnames', () => {
		expect(isBilibiliHostname('bilibili.com')).toBe(true);
		expect(isBilibiliHostname('www.bilibili.com')).toBe(true);
		expect(isBilibiliHostname('evilbilibili.com')).toBe(false);
		expect(isBilibiliHostname('bilibili.com.example.org')).toBe(false);
	});
});
