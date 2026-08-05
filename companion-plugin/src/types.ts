import type {
	DocumentBundleWriteRequest,
	DocumentBundleWriteResponse,
	DocumentCollectionNoteRequest,
	FeishuBridgeCommitResponse,
	FeishuBridgeCreateTransactionRequest,
	FeishuBridgeUploadAssetResponse,
} from '../../src/platforms/feishu/bridge-protocol';

export interface BridgePluginSettings {
	settingsVersion: number;
	port: number;
	pairingTokenHash: string;
	attachmentFolder: string;
	maxAssetBytes: number;
	maxTransactionBytes: number;
	imageMaxBytes: number;
	fileMaxBytes: number;
	sessionMaxBytes: number;
	sessionRetentionMs: number;
	downloadConcurrency: number;
}

export interface StagedAsset extends FeishuBridgeUploadAssetResponse {
	tempPath: string;
	filename: string;
	contentType: string;
}

export interface BridgeTransaction {
	id: string;
	expiresAt: Date;
	request: FeishuBridgeCreateTransactionRequest;
	tempDirectory: string;
	assets: Map<number, StagedAsset>;
	totalBytes: number;
	reservedBytes: number;
	activeAssetIndexes: Set<number>;
}

export interface BridgeTransactionWriter {
	reserveAssetPath(
		transactionId: string,
		index: number,
		filename: string,
		notePath: string
	): string;
	commit(
		transaction: BridgeTransaction,
		content: string
	): Promise<FeishuBridgeCommitResponse>;
	release(transactionId: string): void;
}

export interface DocumentBundleWriter {
	documentNoteExists(path: string): Promise<boolean>;
	renameDocumentCollectionFolder(
		fromPath: string,
		toPath: string,
		ownedNotePaths: string[],
		allowExistingTarget?: boolean
	): Promise<void>;
	commitDocumentBundle(
		request: DocumentBundleWriteRequest
	): Promise<DocumentBundleWriteResponse>;
	commitDocumentCollectionBatch(
		notes: Array<DocumentCollectionNoteRequest & { ownedPath?: string }>
	): Promise<DocumentBundleWriteResponse>;
}
