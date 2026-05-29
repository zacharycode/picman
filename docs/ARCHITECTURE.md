# Picman Architecture

Picman is built around one product rule: files are the source of truth.

Image assets stay as ordinary files inside ordinary folders. Picman may create
metadata, indexes, thumbnails, previews, and search caches, but those artifacts
must remain secondary, inspectable, removable, and rebuildable.

## Storage Layers

1. Source files
   - User-owned images, SVGs, PDFs, videos, and folders.
   - Must remain usable without Picman.

2. Open metadata
   - `.picman-library.json` at the library root.
   - `.picman/folder.json` and `.picman/items.json` inside folders.
   - JSON only, versioned, relative-path based, and cross-platform readable.

3. Local index
   - SQLite or equivalent local store.
   - Used only for speed: search, filters, sorting, and scan state.
   - Safe to delete and rebuild from files plus metadata.

4. Local cache
   - Thumbnails, previews, color analysis, OCR, hashes, and derived data.
   - Stored outside the asset library by default.
   - Must have visible management controls for size, count, clearing,
     compression, and regeneration.

## Planned Library Format

```text
DesignAssets/
  .picman-library.json
  Icons/
    home.png
    search.svg
    .picman/
      folder.json
      items.json
  Inspiration/
    landing-page.png
    .picman/
      folder.json
      items.json
```

## Sync Principle

Dropbox, iOS file authorization, and future external clients should synchronize
or access the same file library directly. They should read and write the open
metadata files, then build their own local indexes and thumbnail caches.

Synchronized:

```text
source files
.picman-library.json
**/.picman/folder.json
**/.picman/items.json
```

Not synchronized:

```text
local SQLite indexes
thumbnail caches
preview caches
temporary scan state
```

## Implementation Boundary

The first MVP is a React/TypeScript app prepared for a Tauri desktop shell.
The UI and domain model are implemented now. The native file-system adapter,
SQLite index, thumbnail generation, and Tauri shell will be added behind stable
interfaces as the desktop layer comes online.
