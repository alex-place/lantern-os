# ADR: Keystone Image Gallery Feature

**Date:** 2026-06-14  
**Status:** ACCEPTED  
**Decision Makers:** Keystone Place  
**Stakeholders:** Keystone agent, debug tools, Convergence IO engine

---

## Problem Statement

Keystone debug console (`keystone-debug.html`) currently has no visual media support. When analyzing code, fetching GitHub issues, or running diagnostics, users cannot:
- Display relevant screenshots or diagrams
- View generated visualizations from analysis tools
- Build a visual audit trail for debugging sessions
- Reference images across conversations

This limits Keystone's utility as a technical auditor, since modern debugging often requires visual evidence (error states, UI layouts, architecture diagrams).

---

## Decision

Implement a **client-side + server-side image gallery system** with the following architecture:

### Frontend (Keystone Desk)
- **Image Gallery Panel** in keystone-debug.html with drag-and-drop upload
- **Modal Viewer** for full-size inspection
- **Metadata Display** (filename, timestamp, size)
- **Keyboard Navigation** (Escape to close modal)
- **Local Storage** of uploaded images (IndexedDB for persistence across sessions)

### Backend (Node.js)
- **Image Handler Module** (`lib/image-handler.js`) — CRUD operations
- **REST Endpoints** in `routes/images.js`:
  - `POST /api/images` — Save new image
  - `GET /api/images` — List all images
  - `GET /images/{id}` — Serve image file
  - `DELETE /api/images/{id}` — Remove image
- **Persistent Storage** in `data/images/` directory with UUID-based filenames
- **Metadata Tracking** (timestamp, size, original filename)

### Integration Points
- **Dream Chat Responses** can reference images via `{ type: "image", id: "..." }`
- **Convergence Loop** can attach diagnostic screenshots to task intake
- **Three Doors Game** can embed visual proof of player state
- **Status Cube** can visualize 4D navigation with images

---

## Design Rationale

### Why Local Storage (Client) + Server Storage (Disk)?
- **Local Storage:** Fast gallery UI, no latency for drag-and-drop, works offline
- **Server Storage:** Persistent across sessions, shareable via URL, backup-able
- **Both:** Gallery syncs on demand (`/api/images` endpoint)

### Why UUID Filenames?
- Prevents filename collisions
- Makes image references immutable (no rename/move breaks links)
- Simplifies garbage collection (can delete by age without parsing names)

### Why Separate Module (`image-handler.js`)?
- Single responsibility: image I/O only
- Reusable across routes (images, dreamer, status endpoints)
- Testable in isolation

### Why Drag-and-Drop + File Input?
- UX best practice: two input methods for accessibility
- Matches modern web app expectations
- No extra dependencies (native File API)

---

## Implementation Steps

### Phase 1: Frontend (Completed)
✅ Updated `keystone-debug.html`:
- Added `.image-gallery` grid layout
- Added `.image-modal` for expanded view
- Added image upload section with drag-drop zone
- Implemented `initImageUpload()`, `handleImageFiles()`, `openImageModal()`

### Phase 2: Backend API (Current)
🔄 Create `routes/images.js`:
```javascript
// POST /api/images — Save image from multipart/form-data
app.post('/api/images', (req, res) => {
  const { file } = req.files;
  const result = saveImage(file.data, file.name);
  res.json(result);
});

// GET /api/images — List all images with metadata
app.get('/api/images', (req, res) => {
  res.json(listImages());
});

// GET /images/:filename — Serve static image
app.use('/images', express.static(IMAGE_STORAGE_DIR));

// DELETE /api/images/:id — Remove image
app.delete('/api/images/:id', (req, res) => {
  const success = deleteImage(req.params.id);
  res.json({ success });
});
```

### Phase 3: Frontend ↔ Server Sync (Next)
- Update `testKeystone()` to fetch images from `/api/images` after chat
- Add image metadata to SSE stream (type: "image_list")
- Auto-populate gallery when Keystone responses include images

### Phase 4: Integration with Convergence Loop (Future)
- CSF ingest documents can reference images via `[[2026-06-14-screenshot.png]]`
- Convergence loop attaches diagnostic images to task metadata
- Three Doors game saves player state screenshots to `/api/images`

---

## Trade-offs

| Choice | Pro | Con |
|--------|-----|-----|
| **Disk storage** vs. database | Simple, filesystem-native, versioning-friendly | Scaling limit ~1000 images/session |
| **Client-side gallery** vs. server render | Responsive, no network lag | Sync complexity for multi-user |
| **UUID filenames** vs. semantic names | Collision-free, immutable | Less readable (mitigated by metadata) |
| **Drag-drop** vs. button only | Better UX | Requires File API (all modern browsers) |

---

## Acceptance Criteria

- [ ] `keystone-debug.html` renders image gallery with upload UI
- [ ] Drag-and-drop + file input both upload images
- [ ] Modal viewer opens on image click, closes on Escape
- [ ] `/api/images` endpoint returns list of stored images with metadata
- [ ] Images persist across page reload (server storage)
- [ ] Keystone responses can reference images (future enhancement)
- [ ] No external image hosting (all data stays local/on-premise)

---

## Consequences

### Positive
- Keystone becomes a **visual debugger**, not just text output
- Easy to audit UI states, error screenshots, generated diagrams
- Foundation for **convergence loop image attachments** (diagnostic proofs)
- Enables **Three Doors visual state capture**

### Negative
- Adds `data/images/` directory (managed cleanup required)
- Introduces **file I/O** to request path (minor latency)
- Requires **storage quota management** (e.g., auto-delete images >30 days old)

---

## Related Decisions

- **CSF Memory Format** — Images can be embedded as base64 in CSF archives (separate ADR)
- **Three Doors State Capture** — Player screenshots stored via `/api/images` endpoint
- **Convergence Loop Phase 15** — "Attach diagnostic images to task metadata"

---

## References

- [keystone-debug.html](../../apps/lantern-garage/public/keystone-debug.html)
- [image-handler.js](../../../apps/lantern-garage/lib/image-handler.js)
- [Status Cube Memory](project_status_cube.md)
- [Convergence Loop](../../docs/CONVERGENCE-LOOP.md)
