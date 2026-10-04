import { load } from 'cheerio';

export function ocrPlainText(text: string): string {
  if (
    !/<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|p|div|span|br|li|ul|ol|script|style|html|body|b|strong|em|i|u|a|h[1-6]|pre|code)(?:\s|\/?>)/i.test(
      text,
    )
  )
    return text;
  const $ = load(text, null, false);
  $('script, style').remove();
  $('br').replaceWith('\n');
  $('td, th').append(' ');
  $('p, div, tr, table, li').append('\n');
  return $.root()
    .text()
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function normalizeOcrText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export function ocrSearchGrams(text: string): string[] {
  const chars = Array.from(normalizeOcrText(text));
  const grams = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) grams.add(chars[i] + chars[i + 1]);
  return [...grams];
}
