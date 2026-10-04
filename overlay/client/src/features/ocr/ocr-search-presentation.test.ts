import { describe, expect, it } from 'vitest'
import { ocrReaderLocation, ocrSnippet } from './ocr-search-presentation'
import { validOcrQuery } from './composables/useOcrSearch'

describe('OCR search presentation', () => {
  it('preserves markup as inert text rather than interpreting it', () => {
    expect(ocrSnippet('<img src=x onerror=alert(1)> synthetic', 'synthetic')).toContain('<img')
  })
  it('centres long snippets around the query and bounds their length', () => {
    const snippet = ocrSnippet(`${'a'.repeat(1000)}target${'b'.repeat(1000)}`, 'target')
    expect(snippet).toContain('target')
    expect(Array.from(snippet).length).toBeLessThanOrEqual(242)
    expect(snippet.startsWith('…')).toBe(true)
  })
  it('keeps distinct same-page hits and their revision in reader links', () => {
    const hit = { fileId: 7, bookId: 8, title: 'Synthetic', page: 2, blockId: 0, text: 'example', bbox: null, fingerprint: 'revision' }
    expect(ocrReaderLocation(hit)).toEqual({ path: '/ocr/read/7', query: { page: '2', block: '0', revision: 'revision' } })
    expect(ocrReaderLocation({ ...hit, blockId: 9 }).query.block).toBe('9')
  })
  it('validates Unicode characters rather than UTF-16 units', () => {
    expect(validOcrQuery('😀')).toBe(false)
    expect(validOcrQuery('😀甲')).toBe(true)
    expect(validOcrQuery('甲乙')).toBe(true)
    expect(validOcrQuery('x'.repeat(129))).toBe(false)
  })
})
