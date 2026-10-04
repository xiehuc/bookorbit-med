import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const script = readFileSync(resolve(process.cwd(), 'public/ocr-reader/reader.js'), 'utf8')

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('isolated BookReader adapter', () => {
  it('uses original pixel coordinates and zero-based leaf numbers for the search overlay', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="BookReader"></div>'
    const updateSearchHilites = vi.fn()
    const jumpToIndex = vi.fn()
    const plugin = { searchResults: null as unknown, updateSearchHilites, search: vi.fn() }
    let options: Record<string, unknown> | undefined
    vi.stubGlobal(
      'BookReader',
      class {
        plugins = { search: plugin }
        constructor(value: Record<string, unknown>) {
          options = value
        }
        init() {}
        jumpToIndex = jumpToIndex
        currentIndex() {
          return 1
        }
      },
    )
    vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    window.eval(script)
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: location.origin,
        source: window,
        data: {
          channel: 'bookorbit-ocr-reader-v1',
          type: 'init',
          page: 2,
          pages: [
            { page: 1, width: 2928, height: 2032 },
            { page: 2, width: 2064, height: 2944 },
          ],
          hit: { page: 2, bbox: [266, 639, 1934, 765] },
        },
      }),
    )
    expect(jumpToIndex).toHaveBeenCalledWith(1)
    expect(updateSearchHilites).toHaveBeenCalled()
    expect(plugin.searchResults).toEqual({
      indexed: true,
      matches: [{ par: [{ page: 1, boxes: [{ page: 1, l: 266, t: 639, r: 1934, b: 765, matchIndex: 0 }] }] }],
    })
    expect(options?.data).toEqual(
      expect.arrayContaining([expect.arrayContaining([expect.objectContaining({ width: 2064, height: 2944, leafNum: 1 })])]),
    )
  })
})
