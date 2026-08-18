// Shared caption prompt, imported by both places captions get written:
//   - the Worker's /api/admin/caption endpoint (static import)
//   - scripts/caption-new-images.js (dynamic import — that file is CommonJS, hence .mjs here)
// Keeping one copy means the style rules and the few-shot examples can't drift apart.

export const CAPTION_MODEL = 'claude-opus-5';

// Opus 5 runs adaptive thinking by default, so max_tokens has to leave room for it even
// though the caption itself is a handful of words. Low effort keeps that overhead small.
export const CAPTION_MAX_TOKENS = 1024;
export const CAPTION_EFFORT = 'low';

const RULES = [
  '2–5 words',
  'no articles (a/an/the) unless essential',
  'wry and observational, never sentimental',
  "never mention the dog's name",
  'no exclamation points',
  'must read standalone — never "again", "also", "same", or anything implying another photo',
].join(', ');

export function buildCaptionPrompt(samples) {
  const sampleList = samples.slice(-12).map((s) => `- ${s}`).join('\n');
  return `Write a one-line caption for this dog photo in this exact style:\n${sampleList}\n\nRules: ${RULES}. Reply with the caption only.`;
}

export function captionRequestBody(base64Jpeg, samples) {
  return {
    model: CAPTION_MODEL,
    max_tokens: CAPTION_MAX_TOKENS,
    output_config: { effort: CAPTION_EFFORT },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } },
          { type: 'text', text: buildCaptionPrompt(samples) },
        ],
      },
    ],
  };
}

// Picks the text block specifically — with thinking on, content[0] is a thinking block.
export function parseCaption(data) {
  const block = (data.content || []).find((b) => b.type === 'text');
  return String((block && block.text) || '').trim().replace(/^["']|["']$/g, '');
}
