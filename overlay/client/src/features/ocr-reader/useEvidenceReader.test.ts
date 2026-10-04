import { defineComponent, shallowRef } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVIDENCE_CHANNEL, positiveInteger, useEvidenceReader } from './useEvidenceReader'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  route: { params: { fileId: '7' }, query: { page: '2', block: '10', revision: 'abc' } as Record<string, string> },
}))
vi.mock('@/lib/api', () => ({ api: mocks.api }))
vi.mock('vue-router', () => ({ useRoute: () => mocks.route }))
const manifest = {
  fileId: 7,
  bookId: 3,
  fingerprint: 'abc',
  pages: [
    { page: 1, source: '1.avif', width: 100, height: 200 },
    { page: 2, source: '2.avif', width: 200, height: 300 },
  ],
}
const hit = { page: 2, blockId: 10, fingerprint: 'abc', bbox: [10, 20, 100, 200], text: '<script>unsafe text</script>' }
const wrappers: ReturnType<typeof mount>[] = []

function harness() {
  const postMessage = vi.fn()
  const source = { postMessage } as unknown as Window
  let state!: ReturnType<typeof useEvidenceReader>
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useEvidenceReader(shallowRef({ contentWindow: source } as HTMLIFrameElement))
        return () => null
      },
    }),
  )
  wrappers.push(wrapper)
  const message = (data: Record<string, unknown>, eventSource: Window = source, origin = location.origin) => {
    window.dispatchEvent(new MessageEvent('message', { source: eventSource, origin, data: { channel: EVIDENCE_CHANNEL, ...data } }))
  }
  return { state, postMessage, message, wrapper }
}

beforeEach(() => {
  mocks.route.query = { page: '2', block: '10', revision: 'abc' }
  mocks.api.mockReset()
  mocks.api.mockImplementation(
    async (url: string) => new Response(JSON.stringify(url.includes('/hit?') ? hit : manifest), { headers: { 'Content-Type': 'application/json' } }),
  )
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})

describe('evidence reader bridge', () => {
  it('validates numeric route values', () => {
    expect(positiveInteger('2')).toBe(2)
    expect(positiveInteger('-1')).toBeNull()
    expect(positiveInteger('1.5')).toBeNull()
    expect(positiveInteger('Infinity')).toBeNull()
  })
  it('loads manifest and hit through authenticated api and sends only data to trusted frame', async () => {
    const { state, postMessage, message } = harness()
    await flushPromises()
    message({ type: 'loaded' })
    expect(state.error.value).toBe('')
    expect(mocks.api).toHaveBeenCalledWith('/api/v1/ocr/files/7/hit?page=2&block=10&revision=abc', expect.objectContaining({ cache: 'no-store' }))
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'init', page: 2, hit }), location.origin)
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('Bearer')
  })
  it('rejects foreign origins and unrelated frame windows', async () => {
    const { postMessage, message } = harness()
    await flushPromises()
    message({ type: 'loaded' }, window, location.origin)
    message({ type: 'loaded' }, window, 'https://example.invalid')
    expect(postMessage).not.toHaveBeenCalled()
  })
  it('refuses stale fingerprints before loading a hit or images', async () => {
    mocks.route.query.revision = 'old'
    const { state, message, postMessage } = harness()
    await flushPromises()
    message({ type: 'loaded' })
    expect(state.error.value).toContain('out of date')
    expect(mocks.api).toHaveBeenCalledTimes(1)
    expect(postMessage).not.toHaveBeenCalled()
  })
  it('does not fetch images for out-of-range page messages', async () => {
    const { message } = harness()
    await flushPromises()
    message({ type: 'image', page: 999 })
    expect(mocks.api).toHaveBeenCalledTimes(2)
  })
  it('reports revision conflict without passing server response text through', async () => {
    mocks.api.mockResolvedValue(new Response('sensitive server detail', { status: 409 }))
    const { state } = harness()
    await flushPromises()
    expect(state.error.value).toContain('out of date')
    expect(state.error.value).not.toContain('sensitive')
  })
})
