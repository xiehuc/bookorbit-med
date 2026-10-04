<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { useOcrSearch, validOcrQuery } from './composables/useOcrSearch'
import { ocrReaderLocation, ocrSnippet } from './ocr-search-presentation'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const query = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))
const offset = computed(() => {
  const n = Number(route.query.offset)
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
})
const libraryId = computed(() => {
  const n = Number(route.query.libraryId)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
})
const draft = ref(query.value)
watch(query, (value) => {
  draft.value = value
})
const canSubmit = computed(() => validOcrQuery(draft.value))
const { items, loading, failed, settled, valid, hasMore, reload } = useOcrSearch(query, offset, libraryId)
const results = computed(() =>
  items.value.map((hit) => ({
    ...hit,
    key: `${hit.fileId}:${hit.page}:${hit.blockId}:${hit.fingerprint}`,
    snippet: ocrSnippet(hit.text, query.value),
    location: ocrReaderLocation(hit),
  })),
)

function submit() {
  if (!canSubmit.value) return
  if (draft.value.trim() === query.value && offset.value === 0) {
    void reload()
    return
  }
  void router.push({ name: 'ocr-search', query: { q: draft.value.trim(), ...(libraryId.value ? { libraryId: String(libraryId.value) } : {}) } })
}
function next() {
  void router.push({ query: { ...route.query, offset: String(offset.value + 20) } })
}
function previous() {
  void router.push({ query: { ...route.query, offset: String(Math.max(0, offset.value - 20)) } })
}
function allLibraries() {
  void router.push({ name: 'ocr-search', query: { q: query.value } })
}
</script>

<template>
  <section class="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6" :aria-label="t('ocrSearch.title')">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{{ t('ocrSearch.title') }}</h1>
      <p class="max-w-2xl text-sm leading-relaxed text-muted-foreground">{{ t('ocrSearch.subtitle') }}</p>
    </header>
    <form class="space-y-2 rounded-xl border border-border bg-card p-4 shadow-sm" @submit.prevent="submit">
      <label for="ocr-query" class="text-sm font-medium text-foreground">{{ t('ocrSearch.label') }}</label>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input
          id="ocr-query"
          v-model="draft"
          type="search"
          autocomplete="off"
          :placeholder="t('ocrSearch.placeholder')"
          aria-describedby="ocr-query-hint"
          class="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" class="h-11" :disabled="!canSubmit || loading">{{ t('ocrSearch.submit') }}</Button>
      </div>
      <p id="ocr-query-hint" class="text-xs leading-relaxed text-muted-foreground">{{ t('ocrSearch.hint') }}</p>
      <div v-if="libraryId" class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{{ t('ocrSearch.scope', { id: libraryId }) }}</span>
        <button type="button" class="text-primary underline underline-offset-4" @click="allLibraries">{{ t('ocrSearch.allLibraries') }}</button>
      </div>
    </form>
    <div v-if="loading" role="status" class="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="failed" role="alert" class="space-y-3 rounded-xl border border-border bg-card p-6">
      <p class="text-sm text-foreground">{{ t('ocrSearch.error') }}</p>
      <Button variant="outline" @click="reload">{{ t('ocrSearch.retry') }}</Button>
    </div>
    <div
      v-else-if="settled && valid && !results.length"
      role="status"
      class="space-y-2 rounded-xl border border-dashed border-border p-10 text-center"
    >
      <h2 class="font-medium text-foreground">{{ t('ocrSearch.empty') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('ocrSearch.emptyHint') }}</p>
      <Button v-if="offset > 0" variant="outline" @click="previous">{{ t('ocrSearch.previous') }}</Button>
    </div>
    <template v-else-if="results.length">
      <p role="status" class="text-xs text-muted-foreground">{{ t('ocrSearch.range', { start: offset + 1, end: offset + results.length }) }}</p>
      <ol class="space-y-3">
        <li v-for="hit in results" :key="hit.key">
          <RouterLink
            :to="hit.location"
            class="group block rounded-xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="min-w-0 break-words text-base font-semibold text-foreground">{{ hit.title || t('ocrSearch.untitled') }}</h2>
              <div class="flex gap-2 text-xs text-muted-foreground">
                <span class="rounded-md bg-muted px-2 py-1">{{ t('ocrSearch.page', { page: hit.page }) }}</span>
                <span class="rounded-md bg-muted px-2 py-1">{{ t('ocrSearch.block', { block: hit.blockId }) }}</span>
              </div>
            </div>
            <p class="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-foreground">{{ hit.snippet }}</p>
            <p v-if="!hit.bbox" class="mt-3 text-xs text-muted-foreground">{{ t('ocrSearch.noBox') }}</p>
            <p class="mt-4 text-xs font-medium text-primary">{{ t('ocrSearch.open') }} →</p>
          </RouterLink>
        </li>
      </ol>
      <nav class="flex items-center justify-between gap-3" :aria-label="t('ocrSearch.title')">
        <Button variant="outline" :disabled="offset === 0" @click="previous">{{ t('ocrSearch.previous') }}</Button>
        <Button variant="outline" :disabled="!hasMore" @click="next">{{ t('ocrSearch.next') }}</Button>
      </nav>
    </template>
  </section>
</template>
