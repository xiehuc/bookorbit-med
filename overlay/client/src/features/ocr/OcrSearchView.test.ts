import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import OcrSearchView from './OcrSearchView.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { q: 'synthetic' } }),
  useRouter: () => ({ push }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/api', () => ({
  api: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      items: [
        {
          fileId: 7,
          bookId: 8,
          title: '<script>bad</script>',
          page: 2,
          blockId: 0,
          text: '<img src=x onerror=alert(1)> synthetic',
          bbox: null,
          fingerprint: 'revision',
        },
      ],
      hasMore: false,
    }),
  })),
}))

describe('OCR result rendering', () => {
  it('renders OCR markup as text and preserves precise reader location', async () => {
    const wrapper = mount(OcrSearchView, {
      global: {
        stubs: {
          Button: { template: '<button><slot /></button>' },
          RouterLink: { name: 'ReaderLinkStub', props: ['to'], template: '<a><slot /></a>' },
        },
      },
    })
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)> synthetic')
    expect(wrapper.findComponent({ name: 'ReaderLinkStub' }).props('to')).toEqual({
      path: '/ocr/read/7',
      query: { page: '2', block: '0', revision: 'revision' },
    })
    wrapper.unmount()
  })
})
