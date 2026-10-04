# OCR evidence reading (custom development build)

This is a modified version of BookOrbit and is not an official BookOrbit release.
Modification date: 2026-09-26. Keep the upstream AGPL license, attribution and additional terms. BookReader is separately distributed under AGPLv3; its vendored license and version record are in `client/public/ocr-reader/vendor/`.

## Data contract

Keep the original CBZ unchanged. Place the canonical v1 OCR JSON beside it, with the same basename (`example.cbz` and `example.ocr.json`). Use a separate PNG for the display cover through BookOrbit's cover management; OCR integration does not generate or rewrite the archive cover.

- `version: 1`, `source_cbz`, `document_id`, `page_count`, `pages`.
- Each page has contiguous 1-based `page`, exact ZIP-entry `source`, original `width`/`height`, and `blocks`.
- Each block has a page-local integer `id`, `text`, and optional original-pixel `bbox: [x1,y1,x2,y2]`.
- Text without a box remains searchable, but has no geometric highlight.
- The importer rejects unsafe paths, duplicate page sources/IDs, inconsistent counts, and invalid boxes. It matches JSON pages by exact ZIP name, not ZIP order or alphabetic order.
- No OCR service is invoked. No patient content is sent to third-party services by this module. Separately review/disable upstream external metadata and sync features for private medical libraries.

## APIs

All APIs use the existing BookOrbit authentication and library/content permissions.

- `GET /api/v1/ocr/search?q=...&offset=0&limit=20&libraryId=...`: optional library filter, bounded pagination. Two to 128 Unicode characters. Returns `items` and `hasMore`.
- `POST /api/v1/ocr/files/:fileId/index`: manual import or refresh. Requires `ManageLibraries` and editor-or-higher access to the library.
- `GET /api/v1/ocr/files/:fileId/manifest`: validated pages and revision.
- `GET /api/v1/ocr/files/:fileId/hit?page=2&block=10&revision=...`: one exact block; stale revisions return 409.
- `GET /api/v1/ocr/files/:fileId/pages/:page?revision=...`: original image bytes. Validates dimensions/orientation; private no-store response. No blanket public immutable image cache.

The OCR database is derived data, linked to BookOrbit file IDs. Apply the generated incremental Drizzle migrations before starting the modified application. Back up the existing database first; do not recreate the upstream baseline migration or wipe an existing database. The block index uses character bigrams as candidates and an exact normalized substring check, supporting Chinese two-character searches without assuming English word tokenization works for Chinese.

The worker starts a nonblocking batch when the server boots, then checks at most 100 catalogued CBZ records every 10 seconds, sequentially. It caches filesystem signatures across restarts and reindexes when the adjacent sidecar changes, without a filesystem watcher. On a 10,000-book library a full sweep may take approximately 17 minutes plus processing time; it discovers only files already catalogued by BookOrbit's own library scanner. Updating a JSON sidecar does not change the CBZ. A missing or invalid source removes its derived OCR index, while transient I/O and database errors retain the previous index for retry. Manual indexing provides an immediate admin/editor refresh.

## User interface

The existing metadata search remains available. The new OCR search entry opens `/ocr/search`. Results open `/ocr/read/:fileId?page=N&block=ID&revision=...`.

BookReader loads only for evidence reading, within a same-origin frame. Authenticated page requests happen in the parent application; tokens do not enter image URLs or frame messages. The frame receives bounded blob URLs and validates message origin and source. Existing ordinary comic reading is unchanged.

## Validation and deployment boundary

Local mirror: batched editing, unit tests, lint and typechecking only. Runtime and database integration validation belong on the remote `vanilla.local` host using its rootless Podman. Never mount or migrate a live BookOrbit database for tests. Temporary test containers use the `bookorbit-ocr-` prefix and a private test network; PostgreSQL is not exposed to the LAN.

Unit tests contain synthetic data only. The private case sample is not committed into tests, public assets or source bundles. Validation on the remote host used isolated rootless Podman containers and an ephemeral PostgreSQL database: migrations 0099 and 0100 applied successfully, and six HTTP integration scenarios passed (permissions, indexing, Chinese substrings, distinct same-page hits, original page bytes and revision handling). A read-only, isolated validation of the supplied private CBZ/sidecar confirmed both pages and ZIP entries against the source; the AVIF decoder read an original image with its expected dimensions without rewriting or logging private text. An isolated headless Firefox smoke test with synthetic images verified that the actual vendored BookReader iframe displays both images and draws the exact original-pixel rectangle on page 2. The client production asset build and local static typechecks passed. A separate same-origin headless Firefox run signed in through the real authentication API, loaded two OCR search results in the Vue app, clicked the first result, reached `/ocr/read/:fileId`, decoded the authorized page image at 120 x 240, and found the selected BookReader rectangle at `[10,20,90,40]` (the `[10,20,100,60]` source bbox). It ran against synthetic data, an ephemeral remote PostgreSQL database, and the remote Vite development client; the production client asset build passed separately. Page zoom/two-page layout, mobile appearance, restart recovery and production library throughput remain unverified gates before rollout. A benchmark from upstream EPUB ingestion is not a benchmark for this OCR extension.
