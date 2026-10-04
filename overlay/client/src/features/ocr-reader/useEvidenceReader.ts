import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'
import type { OcrHit, OcrManifest } from '@bookorbit/types'
import { api } from '@/lib/api'

export const EVIDENCE_CHANNEL = 'bookorbit-ocr-reader-v1'
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_CACHE_BYTES = 96 * 1024 * 1024
const MAX_CACHE_PAGES = 12

export function positiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function useEvidenceReader(frame: Ref<HTMLIFrameElement | null>) {
  const route = useRoute()
  const manifest = shallowRef<OcrManifest | null>(null)
  const hit = shallowRef<OcrHit | null>(null)
  const page = ref(1)
  const loading = ref(true)
  const error = ref('')
  const frameLoaded = ref(false)
  const jumpInput = ref(1)
  let controller = new AbortController()
  let generation = 0
  let active = 0
  let cachedBytes = 0
  const cache = new Map<number, { url: string; bytes: number }>()
  const queued = new Set<number>()
  const pending = new Set<number>()

  function post(type: string, payload: Record<string, unknown> = {}) {
    frame.value?.contentWindow?.postMessage({ channel: EVIDENCE_CHANNEL, type, ...payload }, location.origin)
  }

  function release() {
    generation++
    controller.abort()
    controller = new AbortController()
    cache.forEach((entry) => URL.revokeObjectURL(entry.url))
    cache.clear()
    queued.clear()
    pending.clear()
    cachedBytes = 0
    active = 0
  }

  function failure(response: Response): Error {
    if (response.status === 409) return new Error('This evidence is out of date. Return to search and open the current result.')
    if (response.status === 401 || response.status === 403) return new Error('Your session or access to this document has changed.')
    if (response.status === 404) return new Error('This document or OCR result is no longer available.')
    return new Error(`Unable to load evidence (${response.status}).`)
  }

  async function checkedFetch(url: string) {
    const response = await api(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw failure(response)
    return response
  }

  function initializeFrame() {
    if (!frameLoaded.value || !manifest.value || error.value) return
    post('init', { pages: manifest.value.pages, page: page.value, hit: hit.value })
  }

  async function load() {
    release()
    const current = generation
    loading.value = true
    frameLoaded.value = false
    error.value = ''
    manifest.value = null
    hit.value = null
    const fileId = positiveInteger(route.params.fileId)
    const target = positiveInteger(route.query.page ?? 1)
    const rawBlock = route.query.block
    const block = rawBlock == null ? null : Number(rawBlock)
    const revision = typeof route.query.revision === 'string' ? route.query.revision : ''
    if (!fileId || !target || (block !== null && (!Number.isSafeInteger(block) || block < 0))) {
      error.value = 'Invalid evidence link.'
      loading.value = false
      return
    }
    try {
      const result: OcrManifest = await (await checkedFetch(`/api/v1/ocr/files/${fileId}/manifest`)).json()
      if (current !== generation) return
      if (revision && revision !== result.fingerprint) throw new Error('This evidence is out of date. Return to search and open the current result.')
      if (target > result.pages.length) throw new Error('The requested page no longer exists.')
      let selected: OcrHit | null = null
      if (block !== null) {
        const query = new URLSearchParams({ page: String(target), block: String(block), revision: result.fingerprint })
        selected = await (await checkedFetch(`/api/v1/ocr/files/${fileId}/hit?${query}`)).json()
        if (selected?.fingerprint !== result.fingerprint)
          throw new Error('This evidence is out of date. Return to search and open the current result.')
      }
      if (current !== generation) return
      manifest.value = result
      hit.value = selected
      page.value = target
      jumpInput.value = target
      initializeFrame()
    } catch (reason) {
      if (current === generation && !controller.signal.aborted) error.value = reason instanceof Error ? reason.message : 'Unable to load evidence.'
    } finally {
      if (current === generation) loading.value = false
    }
  }

  function cacheImage(index: number, blob: Blob) {
    while (cache.size && (cache.size >= MAX_CACHE_PAGES || cachedBytes + blob.size > MAX_CACHE_BYTES)) {
      const oldest = cache.keys().next().value!
      const entry = cache.get(oldest)!
      URL.revokeObjectURL(entry.url)
      cache.delete(oldest)
      cachedBytes -= entry.bytes
      post('evict', { page: oldest })
    }
    const url = URL.createObjectURL(blob)
    cache.set(index, { url, bytes: blob.size })
    cachedBytes += blob.size
    post('image', { page: index, url })
  }

  async function fetchImage(index: number, current: number) {
    try {
      const book = manifest.value!
      const response = await checkedFetch(`/api/v1/ocr/files/${book.fileId}/pages/${index}?revision=${encodeURIComponent(book.fingerprint)}`)
      if (Number(response.headers.get('Content-Length')) > MAX_IMAGE_BYTES) throw new Error('This page exceeds the reader image size limit.')
      if (!response.headers.get('Content-Type')?.startsWith('image/')) throw new Error('The page response is not an image.')
      const reader = response.body?.getReader()
      if (!reader) throw new Error('The page response is empty.')
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let size = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_IMAGE_BYTES) {
            await reader.cancel()
            throw new Error('This page exceeds the reader image size limit.')
          }
          chunks.push(new Uint8Array(value))
        }
      } finally {
        reader.releaseLock()
      }
      if (current === generation) cacheImage(index, new Blob(chunks, { type: response.headers.get('Content-Type')! }))
    } catch (reason) {
      if (current === generation && !controller.signal.aborted) {
        error.value = reason instanceof Error ? reason.message : 'Unable to load page.'
        controller.abort()
        queued.clear()
      }
    } finally {
      if (current === generation) {
        active--
        pending.delete(index)
        pump()
      }
    }
  }

  function pump() {
    if (error.value) return
    while (active < 3 && queued.size) {
      const index = queued.values().next().value!
      queued.delete(index)
      pending.add(index)
      active++
      void fetchImage(index, generation)
    }
  }

  function receive(event: MessageEvent) {
    if (event.origin !== location.origin || event.source !== frame.value?.contentWindow || event.data?.channel !== EVIDENCE_CHANNEL) return
    const message = event.data
    if (message.type === 'loaded') {
      frameLoaded.value = true
      initializeFrame()
    }
    if (message.type === 'error') error.value = 'The reading component could not be loaded.'
    if (!manifest.value || error.value) return
    const index = positiveInteger(message.page)
    if (!index || index > manifest.value.pages.length) return
    if (message.type === 'page') {
      page.value = index
      jumpInput.value = index
    }
    if (message.type === 'image') {
      const cached = cache.get(index)
      if (cached) {
        post('image', { page: index, url: cached.url })
        return
      }
      if (!pending.has(index) && queued.size < 32) queued.add(index)
      pump()
    }
  }

  function jump() {
    const target = positiveInteger(jumpInput.value)
    if (target && manifest.value && target <= manifest.value.pages.length) post('jump', { page: target })
  }
  function jumpToHit() {
    if (hit.value) post('jump', { page: hit.value.page })
  }

  window.addEventListener('message', receive)
  watch(() => [route.params.fileId, route.query.page, route.query.block, route.query.revision], load, { immediate: true })
  onBeforeUnmount(() => {
    release()
    window.removeEventListener('message', receive)
  })
  return { manifest, hit, page, loading, error, jumpInput, jump, jumpToHit }
}
