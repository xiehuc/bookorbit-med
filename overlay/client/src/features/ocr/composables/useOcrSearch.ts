import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { OcrSearchHit, OcrSearchResponse } from '@bookorbit/types'
import { api } from '@/lib/api'

export function validOcrQuery(query: string): boolean {
  const length = Array.from(query.trim()).length
  return length >= 2 && length <= 128
}

export function useOcrSearch(query: Ref<string>, offset: Ref<number>, libraryId: Ref<number | undefined>) {
  const items = ref<OcrSearchHit[]>([])
  const hasMore = ref(false)
  const loading = ref(false)
  const failed = ref(false)
  const settled = ref(false)
  const valid = computed(() => validOcrQuery(query.value))
  let generation = 0
  let controller: AbortController | undefined

  async function reload() {
    const current = ++generation
    controller?.abort()
    items.value = []
    hasMore.value = false
    failed.value = false
    settled.value = false
    loading.value = false
    if (!valid.value) return
    const request = new AbortController()
    controller = request
    loading.value = true
    const params = new URLSearchParams({ q: query.value.trim(), offset: String(offset.value), limit: '20' })
    if (libraryId.value !== undefined) params.set('libraryId', String(libraryId.value))
    try {
      const response = await api(`/api/v1/ocr/search?${params}`, { signal: request.signal })
      if (!response.ok) throw new Error('OCR search failed')
      const result: OcrSearchResponse = await response.json()
      if (current !== generation) return
      items.value = result.items
      hasMore.value = result.hasMore
    } catch {
      if (current !== generation || request.signal.aborted) return
      failed.value = true
    } finally {
      if (current === generation) {
        loading.value = false
        settled.value = true
      }
    }
  }

  watch([query, offset, libraryId], reload, { immediate: true })
  onScopeDispose(() => {
    generation += 1
    controller?.abort()
  })
  return { items, hasMore, loading, failed, settled, valid, reload }
}
