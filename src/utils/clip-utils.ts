import Defuddle from 'defuddle/full';
import { setElementHTML } from './dom-utils';
import { platformRegistry } from '../platforms';

// Parse document content for clipping. In reader mode, extracts from
// the article's original HTML to avoid reader UI artifacts.
export async function parseForClip(doc: Document) {
	const url = doc.URL || location.href;
	const readerArticle = doc.querySelector('.obsidian-reader-active .obsidian-reader-content article');
	if (readerArticle) {
		const readerDoc = doc.implementation.createHTMLDocument();
		const originalHtml = readerArticle.getAttribute('data-original-html');
		if (originalHtml) {
			setElementHTML(readerDoc.body, originalHtml);
		} else {
			readerDoc.body.replaceChildren(
				...Array.from(readerArticle.childNodes).map(n => readerDoc.importNode(n, true))
			);
		}
		await platformRegistry.beforeDomNormalize({ document: readerDoc, url });
		const parsed = new Defuddle(readerDoc, { url: '' }).parse();
		return platformRegistry.afterExtract({ document: readerDoc, parsed, url });
	}
	await platformRegistry.beforeDomNormalize({ document: doc, url });
	const parsed = new Defuddle(doc, { url }).parse();
	return platformRegistry.afterExtract({ document: doc, parsed, url });
}
