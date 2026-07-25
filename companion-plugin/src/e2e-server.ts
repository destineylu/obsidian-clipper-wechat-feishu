import {
	DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES,
	DEFAULT_FEISHU_BRIDGE_TRANSACTION_MAX_BYTES,
} from '../../src/platforms/feishu/bridge-protocol';
import { E2eFilesystemWriter } from './e2e-filesystem-writer';
import { BridgeHttpServer } from './server';
import { TransactionStore } from './transaction-store';

const vaultRoot = process.env.CLIPPER_E2E_VAULT_ROOT;
const pairingTokenHash = process.env.CLIPPER_E2E_TOKEN_HASH;
const port = Number(process.env.CLIPPER_E2E_PORT || 28124);
if (!vaultRoot || !pairingTokenHash) {
	throw new Error('E2E Vault root and token hash are required');
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
	throw new Error('E2E port is invalid');
}

const writer = new E2eFilesystemWriter(vaultRoot);
const store = new TransactionStore(writer, {
	maxAssetBytes: DEFAULT_FEISHU_BRIDGE_ASSET_MAX_BYTES,
	maxTransactionBytes: DEFAULT_FEISHU_BRIDGE_TRANSACTION_MAX_BYTES,
	transactionTtlMs: 5 * 60_000,
});
const server = new BridgeHttpServer({
	port,
	pairingTokenHash,
	vaultName: '.e2e-vault',
	store,
});

await server.start();
console.log(`E2E companion ready on 127.0.0.1:${port}`);

const stop = async () => {
	await server.stop();
	process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
