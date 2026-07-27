export interface NoteContentMediaCounts {
	imageCount: number;
	bridgeAttachmentCount: number;
	mediaLinkCount: number;
}

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\(([^)]*)\)/g;
const FEISHU_BRIDGE_ATTACHMENT_PATTERN =
	/!?\[[^\]]*]\(feishu-bridge:\/\/(?:video|file)\/[^)]*\)/gi;
const LINKED_IMAGE_PATTERN =
	/Feishu图片(?:附件)?未内联|飞书图片(?:附件)?未内联/g;
const MEDIA_LINK_PATTERN =
	/微信视频|微信音频|Feishu视频|飞书视频|X视频|视频未内联|音频未内联/g;

export function countNoteContentMedia(
	content: string
): NoteContentMediaCounts {
	const markdownImages = Array.from(
		content.matchAll(MARKDOWN_IMAGE_PATTERN)
	);
	const imageCount = markdownImages.filter(([, target]) =>
		!/^feishu-bridge:\/\/(?:video|file)\//i.test(target.trim())
	).length + (content.match(LINKED_IMAGE_PATTERN) || []).length;

	const bridgeAttachments =
		content.match(FEISHU_BRIDGE_ATTACHMENT_PATTERN) || [];
	const contentWithoutBridgeAttachments = content.replace(
		FEISHU_BRIDGE_ATTACHMENT_PATTERN,
		''
	);

	return {
		imageCount,
		bridgeAttachmentCount: bridgeAttachments.length,
		mediaLinkCount:
			(contentWithoutBridgeAttachments.match(MEDIA_LINK_PATTERN) || [])
				.length,
	};
}
