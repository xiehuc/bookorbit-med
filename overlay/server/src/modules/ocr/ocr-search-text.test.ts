import { describe, expect, it } from 'vitest';
import { normalizeOcrText, ocrPlainText, ocrSearchGrams } from './ocr-search-text';

describe('OCR plain text extraction', () => {
  it('separates adjacent table cells and removes tag names and executable content', () => {
    const text = ocrPlainText('<table><tr><td>CRP</td><td>&lt; 10</td></tr></table><script>private()</script><style>.secret{}</style>');
    expect(text).toBe('CRP < 10');
    expect(text).not.toMatch(/table|td|private|secret/);
  });
  it('preserves literal comparison operators in ordinary OCR text', () => {
    expect(ocrPlainText('CRP < 10 & Hb > 100')).toBe('CRP < 10 & Hb > 100');
  });
});

describe('OCR substring index', () => {
  it('indexes two-character Chinese substrings', () => {
    expect(ocrSearchGrams('牙周炎')).toEqual(['牙周', '周炎']);
    expect(ocrSearchGrams('牙周')).toEqual(['牙周']);
  });
  it('normalizes full width Latin text', () => {
    expect(normalizeOcrText('ＣＲＰ')).toBe('crp');
  });
  it('deduplicates grams and handles non-BMP characters', () => {
    expect(ocrSearchGrams('😀牙😀牙')).toEqual(['😀牙', '牙😀']);
  });
  it('requires at least two characters for indexed search', () => {
    expect(ocrSearchGrams('牙')).toEqual([]);
  });
});
