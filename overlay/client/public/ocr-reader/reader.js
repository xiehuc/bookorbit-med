/* BookReader is isolated here so its legacy CSS and DOM ownership never enter Vue. */
;(() => {
  'use strict'
  const channel = 'bookorbit-ocr-reader-v1'
  const origin = location.origin
  const send = (type, payload = {}) => parent.postMessage({ channel, type, ...payload }, origin)
  const images = new Map()
  const requested = new Set()
  const placeholder = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
  let reader
  let pages = []
  let lastPage = 0
  let disposed = false

  function requestPage(page) {
    if (!requested.has(page)) {
      requested.add(page)
      send('image', { page })
    }
    return `${placeholder}#ocr-page=${page}`
  }

  function paintImages() {
    document.querySelectorAll('img.BRpageimage').forEach((image) => {
      const match = image.src.match(/#ocr-page=(\d+)$/)
      const page = match ? Number(match[1]) : Number(image.dataset.ocrPage)
      if (!page || page > pages.length) return
      image.dataset.ocrPage = String(page)
      const cached = images.get(page)
      if (cached && image.src !== cached) image.src = cached
      else if (!cached && match) requestPage(page)
    })
  }

  function showHit(hit) {
    const plugin = reader?.plugins?.search
    if (!plugin) return
    const bbox = hit?.bbox
    plugin.searchResults = {
      indexed: true,
      matches: bbox
        ? [
            {
              par: [{ page: hit.page - 1, boxes: [{ page: hit.page - 1, l: bbox[0], t: bbox[1], r: bbox[2], b: bbox[3], matchIndex: 0 }] }],
            },
          ]
        : [],
    }
    plugin.updateSearchHilites()
  }

  function init(message) {
    if (reader) return
    pages = message.pages
    const base = new URL('./vendor/BookReader/images/', location.href).href
    reader = new BookReader({
      el: '#BookReader',
      ui: 'full',
      showLogo: false,
      bookTitle: 'Original scan',
      bookLanguage: 'en',
      imagesBaseURL: base,
      data: pages.map((page) => [
        { width: page.width, height: page.height, uri: `${placeholder}#ocr-page=${page.page}`, pageNum: String(page.page), leafNum: page.page - 1 },
      ]),
      plugins: { search: { enabled: true, initialSearchTerm: null }, url: { enabled: false }, iframe: { enabled: false } },
    })
    // The search plugin is used only as a geometry renderer; never call its external search service.
    if (reader.plugins?.search) reader.plugins.search.search = () => {}
    reader.search = () => {}
    reader.init()
    showHit(message.hit)
    reader.jumpToIndex(message.page - 1)
    send('ready')
  }

  const observer = new MutationObserver(paintImages)
  observer.observe(document.getElementById('BookReader'), { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
  const timer = setInterval(() => {
    if (!reader || disposed) return
    paintImages()
    const page = reader.currentIndex() + 1
    if (page !== lastPage && page >= 1 && page <= pages.length) {
      lastPage = page
      send('page', { page })
    }
  }, 250)

  addEventListener('message', (event) => {
    if (event.origin !== origin || event.source !== parent || event.data?.channel !== channel || disposed) return
    const message = event.data
    if (message.type === 'init') init(message)
    if (
      message.type === 'image' &&
      Number.isSafeInteger(message.page) &&
      typeof message.url === 'string' &&
      message.url.startsWith(`blob:${origin}/`)
    ) {
      images.set(message.page, message.url)
      requested.delete(message.page)
      paintImages()
    }
    if (message.type === 'evict') {
      images.delete(message.page)
      requested.delete(message.page)
    }
    if (message.type === 'jump' && reader && Number.isSafeInteger(message.page) && message.page >= 1 && message.page <= pages.length)
      reader.jumpToIndex(message.page - 1)
  })
  addEventListener('pagehide', () => {
    disposed = true
    observer.disconnect()
    clearInterval(timer)
    images.clear()
  })
  addEventListener('error', () => send('error'))
  send('loaded')
})()
