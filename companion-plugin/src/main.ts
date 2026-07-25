import { randomBytes } from 'node:crypto';
import {
	FileSystemAdapter,
	Notice,
	Plugin,
} from 'obsidian';
import { join } from 'node:path';

import {
	DEFAULT_BRIDGE_SETTINGS,
	describeBridgeServerStartError,
	normalizeBridgeSettings,
} from './config';
import { ObsidianVaultWriter } from './obsidian-vault-writer';
import {
	BridgeHttpServer,
	hashPairingToken,
} from './server';
import { BridgeSettingsTab } from './settings';
import { ResumableSessionStore } from './resumable-session-store';
import { TransactionStore } from './transaction-store';
import type { BridgePluginSettings } from './types';

export default class ClipperAttachmentBridgePlugin extends Plugin {
	settings: BridgePluginSettings = { ...DEFAULT_BRIDGE_SETTINGS };
	pendingPairingToken: string | null = null;
	serverStatus = '尚未启动';
	private server: BridgeHttpServer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		if (!/^[a-f0-9]{64}$/i.test(this.settings.pairingTokenHash)) {
			await this.regeneratePairingToken(false);
		}
		this.addSettingTab(new BridgeSettingsTab(this));
		await this.restartServer();
	}

	async onunload(): Promise<void> {
		await this.stopServer();
	}

	async updateSettings(patch: Partial<BridgePluginSettings>): Promise<void> {
		this.settings = {
			...this.settings,
			...patch,
		};
		await this.saveData(this.settings);
		await this.restartServer();
	}

	async regeneratePairingToken(restart = true): Promise<string> {
		const token = randomBytes(32).toString('base64url');
		this.pendingPairingToken = token;
		this.settings.pairingTokenHash = hashPairingToken(token);
		await this.saveData(this.settings);
		if (restart) await this.restartServer();
		return token;
	}

	private async loadSettings(): Promise<void> {
		const stored = await this.loadData() as Partial<BridgePluginSettings> | null;
		this.settings = normalizeBridgeSettings(stored);
		if (JSON.stringify(stored || {}) !== JSON.stringify(this.settings)) {
			await this.saveData(this.settings);
		}
	}

	private async restartServer(): Promise<void> {
		await this.stopServer();
		let server: BridgeHttpServer | null = null;
		try {
			const writer = new ObsidianVaultWriter(this.app, this.settings);
			const adapter = this.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) {
				throw new Error('可恢复附件会话仅支持桌面文件系统 Vault');
			}
			const sessionStore = new ResumableSessionStore(writer, {
				rootDirectory: join(
					adapter.getBasePath(),
					this.app.vault.configDir,
					'plugins',
					this.manifest.id,
					'sessions'
				),
				imageMaxBytes: this.settings.imageMaxBytes,
				fileMaxBytes: this.settings.fileMaxBytes,
				sessionMaxBytes: this.settings.sessionMaxBytes,
				retentionMs: this.settings.sessionRetentionMs,
				downloadConcurrency: this.settings.downloadConcurrency,
			});
			await sessionStore.initialize();
			const store = new TransactionStore(writer, {
				maxAssetBytes: this.settings.maxAssetBytes,
				maxTransactionBytes: this.settings.maxTransactionBytes,
				transactionTtlMs: 5 * 60_000,
			});
			server = new BridgeHttpServer({
				port: this.settings.port,
				pairingTokenHash: this.settings.pairingTokenHash,
				vaultName: this.app.vault.getName(),
				store,
				resumable: {
					store: sessionStore,
					limits: {
						imageBytes: this.settings.imageMaxBytes,
						fileBytes: this.settings.fileMaxBytes,
						sessionBytes: this.settings.sessionMaxBytes,
					},
				},
			});
			await server.start();
			this.server = server;
			this.serverStatus = `已监听 127.0.0.1:${this.settings.port}`;
		} catch (error) {
			if (server) {
				await server.stop().catch(() => undefined);
			}
			const detail = describeBridgeServerStartError(
				error,
				this.settings.port
			);
			this.serverStatus = `启动失败：${detail}`;
			new Notice(
				`Clipper Attachment Bridge 启动失败：${detail}`
			);
		}
	}

	private async stopServer(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server) await server.stop();
	}
}
