import type { OcrSearchHit } from '@bookorbit/types'

/** Keep snippets as plain strings. OCR can contain untrusted markup. */
export function ocrSnippet(text: string, query: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  const index = compact.toLowerCase().indexOf(query.trim().toLowerCase())
  const start = Math.max(0, index - 64)
  const slice = Array.from(compact.slice(start)).slice(0, maxLength).join('')
  return `${start ? '…' : ''}${slice}${start + slice.length < compact.length ? '…' : ''}`
}

export function ocrReaderLocation(hit: OcrSearchHit) {
  return {
    path: `/ocr/read/${hit.fileId}`,
    query: { page: String(hit.page), block: String(hit.blockId), revision: hit.fingerprint },
  }
}
