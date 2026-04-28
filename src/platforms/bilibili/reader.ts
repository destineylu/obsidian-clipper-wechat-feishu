import browser from '../../utils/browser-polyfill';
import { detectBrowser } from '../../utils/browser-detection';
import { createBilibiliPlaybackTracker } from '../../utils/bilibili-playback-tracker';
import { PlatformReaderCaptureContext, PlatformReaderEnhanceContext } from '../types';

interface BilibiliReaderState {
	videoId: string;
	page: string;
	timestamp: number;
	thumbnail: string;
	wasPlaying: boolean;
	videoElement: HTMLVideoElement | null;
}

export function captureBilibiliReaderState({ document }: PlatformReaderCaptureContext): BilibiliReaderState | null {
	const urlMatch = document.URL.match(/\/video\/(BV[\w]+|av\d+)/i);
	if (!urlMatch) return null;

	const pageMatch = document.URL.match(/[?&]p=(\d+)/);
	const videoEl = document.querySelector('video') as HTMLVideoElement | null;
	let videoElement: HTMLVideoElement | null = null;
	let timestamp = 0;
	let wasPlaying = false;

	if (videoEl) {
		timestamp = Math.floor(videoEl.currentTime);
		wasPlaying = !videoEl.paused;
		videoElement = videoEl;
		videoElement.remove();
	}

	const ogImg = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;

	return {
		videoId: urlMatch[1],
		page: pageMatch?.[1] || '1',
		timestamp,
		thumbnail: ogImg?.content || '',
		wasPlaying,
		videoElement,
	};
}

export async function enhanceBilibiliReader(context: PlatformReaderEnhanceContext): Promise<void> {
	const state = context.state as BilibiliReaderState | null | undefined;
	if (!state?.videoId) return;

	const { document: doc, contentBody, settings, getMessage, saveSettings } = context;
	const isBvid = /^BV/i.test(state.videoId);
	const idKey = isBvid ? 'bvid' : 'aid';
	const idVal = isBvid ? state.videoId : state.videoId.slice(2);
	const params = new URLSearchParams({
		[idKey]: idVal,
		page: state.page,
		high_quality: '1',
		danmaku: '0',
		...(state.timestamp > 0 ? { t: String(state.timestamp) } : {})
	});
	const embedUrl = 'https://player.bilibili.com/player.html?' + params.toString();

	const browserType = await detectBrowser();
	const isSafari = ['safari', 'mobile-safari', 'ipad-os'].includes(browserType);
	const playerContainer = doc.createElement('div');
	playerContainer.className = 'player-container' + (settings.pinPlayer ? ' pin-player' : '');

	if (isSafari) {
		const thumbnail = doc.createElement('a');
		thumbnail.href = context.url;
		thumbnail.target = '_blank';
		thumbnail.rel = 'noopener';
		thumbnail.className = 'reader-video-wrapper';
		thumbnail.innerHTML =
			'<img src="' + state.thumbnail + '" style="width:100%;height:100%;object-fit:cover;mix-blend-mode:normal!important;">'
			+ '<svg style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:68px;height:48px;mix-blend-mode:normal!important;" viewBox="0 0 68 48">'
			+ '<path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="#00a1d6"/>'
			+ '<path d="M45 24L27 14v20" fill="white"/></svg>';
		playerContainer.appendChild(thumbnail);
	} else if (state.videoElement) {
		const videoWrapper = doc.createElement('div');
		videoWrapper.className = 'reader-video-wrapper';
		state.videoElement.classList.add('reader-video-player');
		state.videoElement.controls = true;
		videoWrapper.appendChild(state.videoElement);
		playerContainer.appendChild(videoWrapper);
		if (state.timestamp > 0) {
			try {
				state.videoElement.currentTime = state.timestamp;
			} catch {}
		}
		if (state.wasPlaying) {
			const playPromise = state.videoElement.play();
			if (playPromise?.catch) playPromise.catch(() => {});
		}
	} else {
		const iframe = doc.createElement('iframe');
		iframe.src = embedUrl;
		iframe.setAttribute('allowfullscreen', '');
		iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
		iframe.setAttribute('scrolling', 'no');
		playerContainer.appendChild(iframe);
		await browser.runtime.sendMessage({ action: 'enableBilibiliEmbedRule' }).catch(() => {});
	}

	const toggleBar = doc.createElement('div');
	toggleBar.className = 'player-toggles';
	const toggleGroup = doc.createElement('div');
	toggleGroup.className = 'player-toggle-group is-open';

	const createToggle = (label: string, defaultOn: boolean, onChange: (on: boolean) => void) => {
		const wrapper = doc.createElement('label');
		wrapper.className = 'player-toggle' + (defaultOn ? ' is-enabled' : '');
		const toggle = doc.createElement('div');
		toggle.className = 'player-toggle-switch';
		const input = doc.createElement('input');
		input.type = 'checkbox';
		input.checked = defaultOn;
		toggle.appendChild(input);
		const text = doc.createElement('span');
		text.textContent = label;
		wrapper.appendChild(text);
		wrapper.appendChild(toggle);
		wrapper.addEventListener('click', (event) => {
			event.preventDefault();
			input.checked = !input.checked;
			wrapper.classList.toggle('is-enabled', input.checked);
			onChange(input.checked);
		});
		return wrapper;
	};

	toggleGroup.appendChild(createToggle(getMessage('readerPinPlayer'), settings.pinPlayer, (on) => {
		playerContainer.classList.toggle('pin-player', on);
		if (on) {
			playerContainer.appendChild(toggleBar);
		} else {
			playerContainer.after(toggleBar);
		}
		window.dispatchEvent(new CustomEvent('reader-show-nav'));
		settings.pinPlayer = on;
		saveSettings();
	}));

	toggleGroup.appendChild(createToggle(getMessage('readerAutoScroll'), settings.autoScroll, (on) => {
		settings.autoScroll = on;
		saveSettings();
	}));

	toggleGroup.appendChild(createToggle(getMessage('readerHighlightActiveLine'), settings.highlightActiveLine, (on) => {
		settings.highlightActiveLine = on;
		if (!on) {
			doc.querySelectorAll('.bilibili-active-cue').forEach(el => el.classList.remove('bilibili-active-cue'));
		}
		saveSettings();
	}));

	toggleBar.appendChild(toggleGroup);
	playerContainer.appendChild(toggleBar);
	contentBody.insertBefore(playerContainer, contentBody.firstChild);
	initializeBilibiliTimestamps(context);
}

function initializeBilibiliTimestamps(context: PlatformReaderEnhanceContext): void {
	const { document: doc, getMessage, getStickyOffset, scrollTo, programmaticScroll, settings } = context;
	const nativeVideo = doc.querySelector('video.reader-video-player') as HTMLVideoElement | null;
	const iframe = doc.querySelector('iframe[src*="player.bilibili.com"]') as HTMLIFrameElement | null;
	if (!iframe && !nativeVideo) return;

	const transcriptSection = doc.querySelector('.bilibili-transcript') as HTMLElement | null;
	const chaptersSection = doc.querySelector('.bilibili-chapters') as HTMLElement | null;

	const cues: { el: HTMLElement; time: number }[] = [];
	if (transcriptSection) {
		transcriptSection.querySelectorAll('li').forEach(li => {
			const ts = li.querySelector('.bilibili-timestamp[data-time]') as HTMLElement;
			if (ts) cues.push({ el: li as HTMLElement, time: parseInt(ts.dataset.time || '0', 10) });
		});
	}

	const chapterItems: { el: HTMLElement; time: number }[] = [];
	if (chaptersSection) {
		chaptersSection.querySelectorAll('li').forEach(li => {
			const ts = li.querySelector('.bilibili-timestamp[data-time]') as HTMLElement;
			if (ts) chapterItems.push({ el: li as HTMLElement, time: parseInt(ts.dataset.time || '0', 10) });
		});
	}

	if (cues.length === 0 && chapterItems.length === 0) return;

	let initialVideoTime = nativeVideo ? nativeVideo.currentTime : 0;
	if (iframe) {
		try {
			const url = new URL(iframe.src);
			initialVideoTime = parseInt(url.searchParams.get('t') || '0', 10);
		} catch {}
	}

	const playbackTracker = createBilibiliPlaybackTracker(initialVideoTime);
	if (iframe) {
		iframe.addEventListener('load', () => {
			try {
				const url = new URL(iframe.src);
				const t = parseInt(url.searchParams.get('t') || '0', 10);
				playbackTracker.startTracking(t);
			} catch {
				playbackTracker.startTracking(0);
			}
		});
	}

	const onMessage = (event: MessageEvent) => {
		if (!iframe) return;
		const fromIframe = event.source === iframe.contentWindow;
		let fromBilibiliOrigin = false;
		try {
			const eventOriginHost = new URL(event.origin).hostname;
			fromBilibiliOrigin = eventOriginHost.endsWith('bilibili.com');
		} catch {}
		if (!fromIframe && !fromBilibiliOrigin) return;
		playbackTracker.handlePlayerMessage(event.data);
	};
	if (iframe) {
		window.addEventListener('message', onMessage);
	}

	const syncPlaybackStateFromMediaSession = () => {
		const playbackState = (navigator as Navigator & {
			mediaSession?: { playbackState?: string };
		}).mediaSession?.playbackState;
		if (playbackState === 'playing' || playbackState === 'paused' || playbackState === 'none') {
			playbackTracker.syncPlaybackState(playbackState);
		}
	};

	const AUTO_SCROLL_COOLDOWN = 2000;
	let activeIndex = -1;
	let activeCue: HTMLElement | null = null;
	let activeChapterIndex = -1;
	let lastUserScroll = 0;

	window.addEventListener('scroll', () => {
		if (programmaticScroll()) return;
		lastUserScroll = Date.now();
	}, { passive: true });

	let currentPosButton: HTMLButtonElement | null = null;
	if (transcriptSection) {
		currentPosButton = doc.createElement('button');
		currentPosButton.className = 'player-current-pos';
		currentPosButton.textContent = getMessage('readerCurrentPosition');
		transcriptSection.style.position = 'relative';
		transcriptSection.appendChild(currentPosButton);

		currentPosButton.addEventListener('click', () => {
			if (!activeCue) return;
			const rect = activeCue.getBoundingClientRect();
			const targetY = (window.pageYOffset || doc.documentElement.scrollTop)
				+ rect.top - getStickyOffset() - 20;
			scrollTo(targetY);
		});
	}

	const updateActiveSegment = (currentTime: number) => {
		if (cues.length > 0) {
			let newIndex = -1;
			for (let i = cues.length - 1; i >= 0; i--) {
				if (currentTime >= cues[i].time) {
					newIndex = i;
					break;
				}
			}

			if (newIndex !== activeIndex) {
				activeCue?.classList.remove('bilibili-active-cue');

				if (newIndex >= 0 && settings.highlightActiveLine) {
					cues[newIndex].el.classList.add('bilibili-active-cue');
				}

				if (newIndex >= 0 && settings.autoScroll
					&& Date.now() - lastUserScroll > AUTO_SCROLL_COOLDOWN) {
					const rect = cues[newIndex].el.getBoundingClientRect();
					const targetY = (window.pageYOffset || doc.documentElement.scrollTop)
						+ rect.top - getStickyOffset() - 20;
					scrollTo(targetY);
				}

				activeCue = newIndex >= 0 ? cues[newIndex].el : null;
				activeIndex = newIndex;
			}

			if (currentPosButton && activeCue) {
				const rect = activeCue.getBoundingClientRect();
				const stickyOffset = getStickyOffset();
				const isVisible = rect.bottom > stickyOffset && rect.top < window.innerHeight;
				currentPosButton.classList.toggle('is-visible', !isVisible);
			} else if (currentPosButton) {
				currentPosButton.classList.remove('is-visible');
			}
		}

		if (chapterItems.length > 0) {
			let newChapterIndex = -1;
			for (let i = chapterItems.length - 1; i >= 0; i--) {
				if (currentTime >= chapterItems[i].time) {
					newChapterIndex = i;
					break;
				}
			}
			if (newChapterIndex !== activeChapterIndex) {
				if (activeChapterIndex >= 0) {
					chapterItems[activeChapterIndex].el.classList.remove('bilibili-active-cue');
				}
				if (newChapterIndex >= 0 && settings.highlightActiveLine) {
					chapterItems[newChapterIndex].el.classList.add('bilibili-active-cue');
				}
				activeChapterIndex = newChapterIndex;
			}
		}
	};

	const pollInterval = setInterval(() => {
		if (nativeVideo && !doc.contains(nativeVideo)) {
			clearInterval(pollInterval);
			return;
		}
		if (iframe && !doc.contains(iframe)) {
			clearInterval(pollInterval);
			window.removeEventListener('message', onMessage);
			return;
		}
		if (nativeVideo) {
			playbackTracker.syncPlaybackState(nativeVideo.paused ? 'paused' : 'playing');
			updateActiveSegment(nativeVideo.currentTime);
			return;
		}
		syncPlaybackStateFromMediaSession();
		updateActiveSegment(playbackTracker.getEstimatedTime());
	}, 500);

	const seekBilibili = (seconds: number) => {
		if (nativeVideo) {
			nativeVideo.currentTime = seconds;
			const playPromise = nativeVideo.play();
			if (playPromise?.catch) playPromise.catch(() => {});
			return;
		}
		if (!iframe) return;
		const currentSrc = new URL(iframe.src);
		currentSrc.searchParams.set('t', String(seconds));
		currentSrc.searchParams.set('autoplay', '1');
		iframe.src = currentSrc.toString();
	};

	const handleSectionClick = (event: Event) => {
		const target = event.target as HTMLElement;
		const li = target.closest('li') as HTMLElement | null;
		if (!li) return;

		const timestamp = li.querySelector('.bilibili-timestamp[data-time]') as HTMLElement | null;
		if (!timestamp) return;

		const seconds = parseInt(timestamp.dataset.time || '0', 10);
		if (!Number.isFinite(seconds)) return;

		event.preventDefault();
		seekBilibili(seconds);
	};

	[transcriptSection, chaptersSection].forEach((section) => {
		if (!section) return;
		section.addEventListener('click', handleSectionClick);
	});
}

export async function cleanupBilibiliReader(): Promise<void> {
	await browser.runtime.sendMessage({ action: 'disableBilibiliEmbedRule' }).catch(() => {});
}
