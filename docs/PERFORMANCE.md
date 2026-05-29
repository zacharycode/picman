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

5. Stress verification must be repeatable.
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
