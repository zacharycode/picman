# Picman Performance Plan

This document records the performance contract for local libraries around
25000 assets and nested folders. It is not a product roadmap; it is the set of
runtime invariants that protect the file-first app from becoming page-like or
blocking under large local folders.

## Target Scenario

- Around 25000 image assets.
- Around 120 nested folders.
- Source files stay in their original folders.
- Thumbnails and indexes remain rebuildable performance artifacts.

## Required Strategies

1. Opening a local library must use native background scanning.
   - `scan_library_folder_stream` starts quickly and continues on a Rust thread.
   - Results are emitted in small batches.
   - Opening a new folder cancels or ignores stale scan work by `scanId`.

2. Rendering must be virtualized.
   - The central asset surface receives ordered asset ids.
   - Only items around the visible viewport are mounted.
   - Adaptive, masonry, and list views all use virtual layout data.

3. Filtering and sorting must avoid thumbnail-driven full recomputation.
   - Stable catalog data drives ordinary folder, tag, type, search, and sort.
   - Live thumbnail state is read from `assetStore` only when the user filters by
     generated or pending thumbnails.

4. Thumbnail generation must be background and bounded.
   - Native thumbnail generation runs through `generate_thumbnails_stream`.
   - Worker count is capped and based on available parallelism.
   - Worker results are aggregated into batches before reaching the frontend.
   - Frontend thumbnail writes update the incremental asset store, not the
     source asset array.
   - Existing thumbnail files under `.picman/cache/thumbnails` are reused when
     the source file fingerprint, algorithm version, and quality still match.

5. Fast scrolling must prioritize interaction smoothness.
   - The app keeps native platform scrolling behavior.
   - Overscan grows in the active scroll direction when scroll velocity is high.
   - Newly mounted thumbnails can defer image loading while the user is moving
     quickly, then load after scrolling settles.

6. File-first performance artifacts must remain rebuildable.
   - `.picman/cache` is a local performance layer, not source of truth.
   - Future tags, metadata, and settings should remain file-readable and
     controllable rather than being hidden in an opaque database.

7. Stress verification must be repeatable.
   - Generate the large test folder:

     ```bash
     npm run stress:create -- --count=25000 --folders=120 --output=/tmp/picman-stress-25000 --clean
     ```

   - Run the performance invariant audit:

     ```bash
     npm run stress:audit -- --library=/tmp/picman-stress-25000 --min-count=25000
     ```

## Completion Evidence

The active performance goal is not considered complete from code structure
alone. It needs both:

- Passing invariant checks from `npm run stress:audit`.
- Manual or automated runtime evidence that the packaged app can open the
  25000 asset library, switch views, search, select, and generate thumbnails
  without making the interface unusable.

### 2026-05-31 Runtime Evidence

- `npm run stress:audit -- --library=/tmp/picman-stress-25000 --min-count=25000`
  passed 21/21 invariants after adding cache restore and fast-scroll checks.
- `cargo test` passed 5 thumbnail/cache tests, including existing-cache reuse
  before source decode and scan-time thumbnail cache restoration.
- `npm run lint`, `npm run build`, `npm run desktop:build`, `npm run release:prepare`,
  and codesign verification passed for v0.1.16.
- GitHub Release `v0.1.16` was published with DMG, updater archive, signature,
  and `latest.json`.

### 2026-05-29 Runtime Evidence

- `npm run stress:audit -- --library=/tmp/picman-stress-25000 --min-count=25000`
  passed 17/17 invariants.
- The packaged macOS app opened `/tmp/picman-stress-25000` and scanned 25000
  assets without blocking the interface.
- Standard thumbnail generation completed for all 25000 assets while the UI
  stayed responsive enough to switch to list view during generation.
- Final standard thumbnail cache: 25000 files, about 159M total, with 21250 JPG,
  2500 PNG, and 1250 SVG files.
