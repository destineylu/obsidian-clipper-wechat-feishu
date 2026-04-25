import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const officialChromeExtensionId = process.env.OFFICIAL_CLIPPER_CHROME_EXTENSION_ID
	|| 'cnjifjpddelmedmihgijeibhnjfabmlf';
const officialVersionSource = process.env.OFFICIAL_CLIPPER_VERSION_SOURCE
	|| 'chrome-web-store';
const chromeUpdateUrl = process.env.OFFICIAL_CLIPPER_CHROME_UPDATE_URL
	|| `https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=120.0.0.0&acceptformat=crx3&x=id%3D${officialChromeExtensionId}%26uc`;
const officialPackageUrl = process.env.OFFICIAL_CLIPPER_PACKAGE_URL
	|| 'https://raw.githubusercontent.com/obsidianmd/obsidian-clipper/main/package.json';
const required = process.argv.includes('--required');
const explicitVersionArg = process.argv.find(arg => arg.startsWith('--version='));
const explicitVersion = explicitVersionArg?.slice('--version='.length) || process.env.OFFICIAL_CLIPPER_VERSION;

function readJson(relativePath) {
	return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function writeJson(relativePath, data) {
	writeFileSync(path.join(root, relativePath), `${JSON.stringify(data, null, '\t')}\n`, 'utf8');
}

function replaceVersionField(relativePath, version) {
	const filePath = path.join(root, relativePath);
	const source = readFileSync(filePath, 'utf8');
	const nextSource = source.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
	if (nextSource !== source) {
		writeFileSync(filePath, nextSource, 'utf8');
		return true;
	}
	return false;
}

function isSemver(version) {
	return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

function toManifestVersion(version) {
	const stableVersion = version.split(/[+-]/)[0];
	if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(stableVersion)) {
		throw new Error(`Official version "${version}" cannot be used as a browser manifest version.`);
	}
	return stableVersion;
}

async function fetchOfficialVersion() {
	if (explicitVersion) return explicitVersion;

	const sources = officialVersionSource.split(',').map(source => source.trim()).filter(Boolean);
	const errors = [];
	for (const source of sources) {
		try {
			if (source === 'chrome-web-store') return await fetchChromeWebStoreVersion();
			if (source === 'github-main') return await fetchGithubMainVersion();
			throw new Error(`Unknown version source "${source}"`);
		} catch (error) {
			errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(`Could not resolve official version. ${errors.join('; ')}`);
}

async function fetchChromeWebStoreVersion() {
	const response = await fetch(chromeUpdateUrl, {
		headers: { Accept: 'application/xml,text/xml,*/*' },
		signal: AbortSignal.timeout(8000),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} while fetching Chrome Web Store update metadata`);
	}

	const updateXml = await response.text();
	const version = updateXml.match(/\bversion="([^"]+)"/)?.[1];
	if (!version) {
		throw new Error('Chrome Web Store update metadata did not include a version');
	}
	return version;
}

async function fetchGithubMainVersion() {
	const response = await fetch(officialPackageUrl, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(8000),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} while fetching ${officialPackageUrl}`);
	}

	const officialPackage = await response.json();
	return officialPackage.version;
}

function currentVersion() {
	return readJson('package.json').version;
}

let officialVersion;
try {
	officialVersion = await fetchOfficialVersion();
} catch (error) {
	if (required) {
		throw error;
	}
	console.warn(`[sync-official-version] Could not fetch official version: ${error instanceof Error ? error.message : String(error)}`);
	console.warn(`[sync-official-version] Keeping current version ${currentVersion()}.`);
	process.exit(0);
}

if (!isSemver(officialVersion)) {
	throw new Error(`Invalid official version: ${officialVersion}`);
}

const manifestVersion = toManifestVersion(officialVersion);
const touched = [];

const packageJson = readJson('package.json');
if (packageJson.version !== officialVersion) {
	packageJson.version = officialVersion;
	writeJson('package.json', packageJson);
	touched.push('package.json');
}

const packageLock = readJson('package-lock.json');
let lockChanged = false;
if (packageLock.version !== officialVersion) {
	packageLock.version = officialVersion;
	lockChanged = true;
}
if (packageLock.packages?.['']?.version !== officialVersion) {
	packageLock.packages[''].version = officialVersion;
	lockChanged = true;
}
if (lockChanged) {
	writeJson('package-lock.json', packageLock);
	touched.push('package-lock.json');
}

for (const manifestPath of [
	'src/manifest.chrome.json',
	'src/manifest.firefox.json',
	'src/manifest.safari.json',
]) {
	if (readJson(manifestPath).version !== manifestVersion) {
		replaceVersionField(manifestPath, manifestVersion);
		touched.push(manifestPath);
	}
}

if (touched.length) {
	console.log(`[sync-official-version] Synced to official version ${officialVersion}: ${touched.join(', ')}`);
} else {
	console.log(`[sync-official-version] Already aligned with official version ${officialVersion}.`);
}
