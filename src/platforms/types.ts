import { ReaderSettings } from '../types/types';
import type browser from '../utils/browser-polyfill';

export interface PlatformContentContext {
	document: Document;
	url: string;
}

export interface PlatformExtractContext extends PlatformContentContext {
	parsed: any;
}

export interface PlatformStructuredContent extends Partial<{
	author: string;
	content: string;
	description: string;
	image: string;
	published: string;
	site: string;
	title: string;
	wordCount: number;
}> {
	variables?: Record<string, string>;
}

export interface PlatformMarkdownContext {
	content: string;
	currentUrl: string;
}

export interface PlatformMarkdownResult {
	content: string;
	markdownBody?: string;
	prefixMarkdown?: string;
	debugInfo?: Record<string, unknown>;
}

export interface PlatformBackgroundContext {
	request: { action?: string; [key: string]: any };
	sender: browser.Runtime.MessageSender;
	sendResponse: (response?: any) => void;
}

export type PlatformBackgroundHandler = (context: PlatformBackgroundContext) => true | undefined;

export interface PlatformReaderContent {
	content: string;
	title?: string;
	author?: string;
	published?: string;
	domain?: string;
	wordCount?: number;
	parseTime?: number;
	extractorType?: string;
}

export interface PlatformReaderCaptureContext {
	document: Document;
	url: string;
}

export interface PlatformReaderEnhanceContext {
	document: Document;
	contentBody: HTMLElement;
	url: string;
	state?: unknown;
	settings: ReaderSettings;
	saveSettings: () => void;
	getMessage: (key: string, substitutions?: string | string[]) => string;
	getStickyOffset: () => number;
	scrollTo: (targetY: number, duration?: number) => void;
	programmaticScroll: () => boolean;
}

export interface PlatformModule {
	id: string;
	matches(url: string): boolean;
	beforeDomNormalize?(context: PlatformContentContext): Promise<void> | void;
	afterExtract?(context: PlatformExtractContext): Promise<any> | any;
	extractStructuredContent?(context: PlatformContentContext): Promise<PlatformStructuredContent | null> | PlatformStructuredContent | null;
	afterMarkdown?(context: PlatformMarkdownContext): Promise<PlatformMarkdownResult | null> | PlatformMarkdownResult | null;
	registerBackgroundHandlers?(): PlatformBackgroundHandler[];
	extractReaderContent?(context: PlatformReaderCaptureContext): Promise<PlatformReaderContent | null> | PlatformReaderContent | null;
	captureReaderState?(context: PlatformReaderCaptureContext): Promise<unknown> | unknown;
	enhanceReader?(context: PlatformReaderEnhanceContext): Promise<void> | void;
	onReaderRestore?(context: PlatformReaderCaptureContext): Promise<void> | void;
}
