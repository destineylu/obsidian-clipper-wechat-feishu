import { describe, expect, test } from 'vitest';

import {
	BRIDGE_SETTINGS_VERSION,
	DEFAULT_BRIDGE_PORT,
	DEFAULT_BRIDGE_SETTINGS,
	describeBridgeServerStartError,
	LEGACY_BRIDGE_PORT,
	normalizeBridgeSettings,
} from './config';

describe('companion bridge settings', () => {
	test('migrates the legacy default port that conflicts with Local REST API', () => {
		const settings = normalizeBridgeSettings({
			...DEFAULT_BRIDGE_SETTINGS,
			settingsVersion: 1,
			port: LEGACY_BRIDGE_PORT,
		});

		expect(settings.port).toBe(DEFAULT_BRIDGE_PORT);
		expect(settings.settingsVersion).toBe(BRIDGE_SETTINGS_VERSION);
	});

	test('preserves a custom port while upgrading the settings schema', () => {
		const settings = normalizeBridgeSettings({
			...DEFAULT_BRIDGE_SETTINGS,
			settingsVersion: 1,
			port: 28124,
		});

		expect(settings.port).toBe(28124);
		expect(settings.settingsVersion).toBe(BRIDGE_SETTINGS_VERSION);
	});

	test('preserves a deliberate legacy-port choice after migration', () => {
		const settings = normalizeBridgeSettings({
			...DEFAULT_BRIDGE_SETTINGS,
			settingsVersion: BRIDGE_SETTINGS_VERSION,
			port: LEGACY_BRIDGE_PORT,
		});

		expect(settings.port).toBe(LEGACY_BRIDGE_PORT);
	});

	test('reports an occupied port without exposing internals', () => {
		const error = Object.assign(new Error('listen failed'), {
			code: 'EADDRINUSE',
		});

		expect(describeBridgeServerStartError(error, DEFAULT_BRIDGE_PORT)).toBe(
			`端口 ${DEFAULT_BRIDGE_PORT} 已被其他程序或插件占用`
		);
	});
});
