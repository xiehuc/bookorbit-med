const MAX_SNIPPET_LENGTH = 1000;

/** Search previews are normalized plain text; the hit endpoint retains the original block text. */
export function ocrSearchSnippet(text: string, query: string): string {
  const plain = text.normalize('NFKC');
  if (plain.length <= MAX_SNIPPET_LENGTH) return plain;
  const index = plain.toLowerCase().indexOf(query.normalize('NFKC').toLowerCase());
  const start = Math.max(0, (index < 0 ? 0 : index) - 200);
  return plain.slice(start, start + MAX_SNIPPET_LENGTH);
}
