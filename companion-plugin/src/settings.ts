import {
	Notice,
	PluginSettingTab,
	Setting,
} from 'obsidian';

import type ClipperAttachmentBridgePlugin from './main';

export class BridgeSettingsTab extends PluginSettingTab {
	constructor(private readonly plugin: ClipperAttachmentBridgePlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Clipper Attachment Bridge' });
		containerEl.createEl('p', {
			text: '服务仅监听 127.0.0.1。飞书凭据保留在浏览器扩展中，配套插件只接收二进制附件和最终笔记内容。',
		});

		new Setting(containerEl)
			.setName('服务状态')
			.setDesc(this.plugin.serverStatus);

		new Setting(containerEl)
			.setName('本机端口')
			.setDesc('浏览器扩展必须使用相同端口。')
			.addText(text => {
				text
					.setPlaceholder('27125')
					.setValue(String(this.plugin.settings.port))
					.onChange(async value => {
						const port = Number(value);
						if (
							Number.isInteger(port) &&
							port >= 1024 &&
							port <= 65535 &&
							port !== this.plugin.settings.port
						) {
							await this.plugin.updateSettings({ port });
							this.display();
						}
					});
			});

		new Setting(containerEl)
			.setName('附件目录')
			.setDesc('相对于当前 Vault 根目录，例如 Attachments/Web Clipper。')
			.addText(text => {
				text
					.setPlaceholder('Attachments/Web Clipper')
					.setValue(this.plugin.settings.attachmentFolder)
					.onChange(async value => {
						const folder = value.trim();
						if (folder && folder !== this.plugin.settings.attachmentFolder) {
							await this.plugin.updateSettings({
								attachmentFolder: folder,
							});
						}
					});
			});

		const generatedToken = this.plugin.pendingPairingToken;
		if (generatedToken) {
			new Setting(containerEl)
				.setName('新配对令牌')
				.setDesc('令牌只显示到 Obsidian 重启前。复制到浏览器扩展后请妥善保管。')
				.addText(text => {
					text.setValue(generatedToken);
					text.inputEl.readOnly = true;
				})
				.addButton(button => {
					button
						.setButtonText('复制')
						.setCta()
						.onClick(async () => {
							await navigator.clipboard.writeText(generatedToken);
							new Notice('配对令牌已复制');
						});
				});
		}

		new Setting(containerEl)
			.setName('重新生成配对令牌')
			.setDesc('旧令牌会立即失效，需要同步更新浏览器扩展设置。')
			.addButton(button => {
				button
					.setButtonText('重新生成')
					.setWarning()
					.onClick(async () => {
						await this.plugin.regeneratePairingToken();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName('单附件上限')
			.setDesc(`${Math.round(this.plugin.settings.maxAssetBytes / 1024 / 1024)} MiB`);

		new Setting(containerEl)
			.setName('单次保存总上限')
			.setDesc(`${Math.round(this.plugin.settings.maxTransactionBytes / 1024 / 1024)} MiB`);

		new Setting(containerEl)
			.setName('可恢复图片上限')
			.setDesc(`${Math.round(this.plugin.settings.imageMaxBytes / 1024 / 1024)} MiB/张`);

		new Setting(containerEl)
			.setName('可恢复视频或文件上限')
			.setDesc(`${(this.plugin.settings.fileMaxBytes / 1024 / 1024 / 1024).toFixed(1)} GiB/个`);

		new Setting(containerEl)
			.setName('可恢复会话总上限')
			.setDesc(`${(this.plugin.settings.sessionMaxBytes / 1024 / 1024 / 1024).toFixed(1)} GiB`);

		new Setting(containerEl)
			.setName('下载并发数')
			.setDesc(String(this.plugin.settings.downloadConcurrency));
	}
}
