/**
 * Placeholder for the shared paste detector; replaced by the real module when
 * the branches merge. Only the exported signatures matter here.
 */
const PASTE_RE = /<pasted_content\b[^>\n]*>[\s\S]*?(?:<\/pasted_content\b[^>\n]*>|$)/g;

export function stripPastedContent(text: string): string {
  return text.replace(PASTE_RE, " ");
}

export function isPasteOnly(text: string): boolean {
  return text.includes("<pasted_content") && stripPastedContent(text).trim().length === 0;
}
