<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Crosshair, LoaderCircle } from '@lucide/vue'
import { useEvidenceReader } from './useEvidenceReader'

const route = useRoute()
const router = useRouter()
const frame = ref<HTMLIFrameElement | null>(null)
const { manifest, hit, page, loading, error, jumpInput, jump, jumpToHit } = useEvidenceReader(frame)
const frameKey = computed(() => `${route.params.fileId}:${String(route.query.page)}:${String(route.query.block)}:${String(route.query.revision)}`)

function goBack() {
  if (window.history.state.back) router.back()
  else void router.push('/ocr/search')
}
</script>

<template>
  <main class="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
    <header class="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3">
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        @click="goBack"
      >
        <ArrowLeft class="size-4" aria-hidden="true" /> Back to results
      </button>
      <div class="min-w-0 flex-1">
        <h1 class="text-base font-semibold">Evidence reader</h1>
        <p class="text-xs text-muted-foreground">Original scan · OCR block-level location</p>
      </div>
      <form v-if="manifest && !error" class="flex items-center gap-2 text-sm" @submit.prevent="jump">
        <label for="ocr-page">Page</label>
        <input
          id="ocr-page"
          v-model.number="jumpInput"
          type="number"
          min="1"
          :max="manifest.pages.length"
          class="w-20 rounded-md border border-border bg-background px-2 py-1"
        />
        <span class="text-muted-foreground">/ {{ manifest.pages.length }}</span>
        <button type="submit" class="rounded-md bg-primary px-3 py-1 text-primary-foreground">Go</button>
      </form>
    </header>
    <div v-if="error" role="alert" class="m-6 rounded-lg border border-destructive bg-card p-5 text-destructive">{{ error }}</div>
    <div v-else class="relative flex min-h-0 flex-1 flex-col lg:flex-row">
      <div v-if="loading" role="status" class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background">
        <LoaderCircle class="size-5 animate-spin" aria-hidden="true" /> Loading evidence…
      </div>
      <iframe
        :key="frameKey"
        ref="frame"
        src="/ocr-reader/index.html"
        title="Scanned pages with OCR evidence highlight"
        class="min-h-0 w-full flex-1 border-0"
        referrerpolicy="no-referrer"
      />
      <aside
        v-if="hit"
        aria-label="Selected OCR result"
        class="max-h-48 shrink-0 overflow-y-auto border-t border-border bg-card p-4 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0"
      >
        <div class="mb-3 flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold">Selected evidence</h2>
          <button type="button" class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted" @click="jumpToHit">
            <Crosshair class="size-4" aria-hidden="true" /> Page {{ hit.page }}
          </button>
        </div>
        <p class="mb-3 text-xs text-muted-foreground">
          {{
            hit.bbox
              ? 'The highlighted area is an OCR block, not an individual word.'
              : 'This OCR block has no coordinates. Only its page can be located.'
          }}
        </p>
        <p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{{ hit.text }}</p>
      </aside>
    </div>
    <footer v-if="manifest && !error" class="border-t border-border px-4 py-1 text-xs text-muted-foreground" aria-live="polite">
      Page {{ page }} · Original file unchanged
    </footer>
  </main>
</template>
