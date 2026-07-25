import { describe, expect, test } from 'vitest';

import {
	DEFAULT_FEISHU_BRIDGE_ENDPOINT,
	LEGACY_FEISHU_BRIDGE_ENDPOINT,
} from './feishu/bridge-protocol';
import {
	defaultPlatformSettings,
	mergePlatformSettings,
} from './settings';

describe('platform settings migration', () => {
	test('defaults new installations to linked videos and large attachments', () => {
		const settings = mergePlatformSettings(undefined);

		expect(settings.feishu.attachmentMode).toBe('links');
	});

	test('preserves the old all-local bridge behavior for existing users', () => {
		const settings = mergePlatformSettings({
			feishu: {
				downloadImages: false,
				imageMode: 'obsidian-bridge',
				bridgeEndpoint: DEFAULT_FEISHU_BRIDGE_ENDPOINT,
				bridgePairingToken: 'configured',
				bridgeConfigVersion: 2,
			},
		} as never);

		expect(settings.feishu.attachmentMode).toBe('obsidian-bridge');
	});

	test('keeps linked attachments when the previous image mode was not bridge', () => {
		const settings = mergePlatformSettings({
			feishu: {
				downloadImages: false,
				imageMode: 'links',
				bridgeEndpoint: DEFAULT_FEISHU_BRIDGE_ENDPOINT,
				bridgePairingToken: '',
				bridgeConfigVersion: 2,
			},
		} as never);

		expect(settings.feishu.attachmentMode).toBe('links');
	});

	test('moves the legacy bridge default away from the Local REST API port', () => {
		const settings = mergePlatformSettings({
			feishu: {
				...defaultPlatformSettings.feishu,
				bridgeEndpoint: LEGACY_FEISHU_BRIDGE_ENDPOINT,
				bridgeConfigVersion: 1,
			},
		});

		expect(settings.feishu.bridgeEndpoint).toBe(
			DEFAULT_FEISHU_BRIDGE_ENDPOINT
		);
		expect(settings.feishu.bridgeConfigVersion).toBe(2);
	});

	test('preserves an explicitly configured custom bridge endpoint', () => {
		const settings = mergePlatformSettings({
			feishu: {
				...defaultPlatformSettings.feishu,
				bridgeEndpoint: 'http://127.0.0.1:28124',
				bridgeConfigVersion: 1,
			},
		});

		expect(settings.feishu.bridgeEndpoint).toBe(
			'http://127.0.0.1:28124'
		);
	});

	test('preserves a deliberate legacy-port choice after migration', () => {
		const settings = mergePlatformSettings({
			feishu: {
				...defaultPlatformSettings.feishu,
				bridgeEndpoint: LEGACY_FEISHU_BRIDGE_ENDPOINT,
				bridgeConfigVersion: 2,
			},
		});

		expect(settings.feishu.bridgeEndpoint).toBe(
			LEGACY_FEISHU_BRIDGE_ENDPOINT
		);
	});
});
