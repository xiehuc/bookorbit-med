import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useOcrSearch } from './useOcrSearch'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))
const response = (text: string, hasMore = false) => ({ ok: true, json: async () => ({ items: [{ text }], hasMore }) }) as Response
let scope: ReturnType<typeof effectScope>
beforeEach(() => {
  vi.clearAllMocks()
  scope = effectScope()
})
afterEach(() => {
  scope.stop()
})

describe('OCR search requests', () => {
  it('uses authenticated API, pagination and optional library scope', async () => {
    vi.mocked(api).mockResolvedValue(response('synthetic', true))
    const search = scope.run(() => useOcrSearch(ref('甲乙'), ref(20), ref(5)))!
    await flushPromises()
    expect(api).toHaveBeenCalledWith(
      '/api/v1/ocr/search?q=%E7%94%B2%E4%B9%99&offset=20&limit=20&libraryId=5',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(search.items.value).toEqual([{ text: 'synthetic' }])
    expect(search.hasMore.value).toBe(true)
  })
  it('does not send invalid short or overlong queries', async () => {
    const query = ref('甲')
    scope.run(() => useOcrSearch(query, ref(0), ref(undefined)))
    query.value = 'x'.repeat(129)
    await nextTick()
    expect(api).not.toHaveBeenCalled()
  })
  it('ignores late stale responses after a new query', async () => {
    let resolveOld!: (value: Response) => void
    vi.mocked(api)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          }),
      )
      .mockResolvedValue(response('new'))
    const query = ref('old')
    const search = scope.run(() => useOcrSearch(query, ref(0), ref(undefined)))!
    query.value = 'new'
    await flushPromises()
    resolveOld(response('old'))
    await flushPromises()
    expect(search.items.value).toEqual([{ text: 'new' }])
  })
  it('reports errors separately from empty results and can retry', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValue(response('retry'))
    const search = scope.run(() => useOcrSearch(ref('query'), ref(0), ref(undefined)))!
    await flushPromises()
    expect(search.failed.value).toBe(true)
    await search.reload()
    expect(search.failed.value).toBe(false)
    expect(search.items.value).toEqual([{ text: 'retry' }])
  })
})
