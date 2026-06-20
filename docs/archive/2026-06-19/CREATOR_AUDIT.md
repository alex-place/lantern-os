# LANTERN OS CREATOR SUITE — ARCHITECTURE AUDIT

**Generated:** 2026-06-13  
**Repository:** https://github.com/alex-place/lantern-os  
**Current State:** V7 editor scripts (external), basic upload infrastructure, dream journal storage

---

## EXECUTIVE SUMMARY

Lantern OS has the foundation for a Creator Suite but requires systematic integration:

- ✅ **Existing:** Dream Journal storage (JSONL), file upload infrastructure, dashboard framework
- ✅ **Existing:** Multiple video editor prototypes (V5-V7) with motion/action detection
- ✅ **Existing:** FFmpeg integration proven in external scripts
- ❌ **Missing:** Integrated AI highlight engine in platform
- ❌ **Missing:** Retention variant (A/B/C) generation system
- ❌ **Missing:** Smart caption engine (currently hardcoded in scripts)
- ❌ **Missing:** Short-form export system
- ❌ **Missing:** Creator Dashboard (UI only, no backend)
- ❌ **Missing:** Job/worker system for async processing
- ❌ **Missing:** Analytics and viral scoring system
- ❌ **Missing:** Autonomous creator daemon

---

## ARCHITECTURE OVERVIEW

### Current System Architecture

```
LANTERN OS
├── apps/lantern-garage (Node.js server)
│   ├── server.js (main entrypoint, port 4177)
│   ├── routes/ (REST API endpoints)
│   ├── lib/ (services and utilities)
│   └── public/ (frontend HTML/CSS/JS)
│
├── data/ (persistent storage — JSONL/JSON files)
│   ├── dreamer/notebooks/*.jsonl (dream journal entries)
│   ├── dreamer/videos/* (uploaded videos — new)
│   ├── conversations/ (chat logs)
│   └── [other data stores]
│
├── src/ (Python services)
│   ├── mcp_server/ (MCP protocol implementation)
│   └── [other Python utilities]
│
└── [external] V7 Video Editor Scripts
    ├── lantern_v7_gaming_edition.py
    ├── lantern_v7_verified_editor.py
    └── create_viral_short_*.py variants
```

### Server Entry Points

**Main Server:** `apps/lantern-garage/server.js`
- Port: 4177 (localhost) or 0.0.0.0 (cloud)
- Framework: Plain Node.js (no Express)
- Route pattern: if statements on URL pathname
- Dependency injection: shared `deps` bundle passed to all route modules

### Route Architecture

Routes are loaded in `server.js` from `routes/` directory and composed into single router function:

Each route module:
- Exports async function(req, res, url, deps)
- Returns true if it handled the request, false otherwise
- Has access to shared: fs, http utils, data stores, AI services

---

## EXISTING COMPONENTS AUDIT

### 1. UPLOAD INFRASTRUCTURE ✅

**File:** `routes/dreamer.js`

**POST /api/dreamer/upload**
- Accepts multipart/form-data with busboy
- Fields: entry (JSON), file (video)
- Stores: /data/dreamer/videos/{timestamp}-{filename}
- Returns: saved entry + file metadata

**Status:** WORKING (just fixed in #354)
- Form submission: create.html → FormData with JSON entry
- Backend parsing: busboy field events → JSON.parse → map to dreamer schema
- Schema mapping: title→name, type→kind, project→mood, description→text, tags→array
- Recent entries display: loadRecentEntries() handles field name variations

### 2. DREAM JOURNAL STORAGE ✅

**File:** `lib/dreamer-store.js`

**Functions:**
- `readDreamerNotebook(user)` — Load all entries for user
- `appendDreamerEntry(user, entry)` — Append JSONL entry
- `readRecentDreams(count)` — Get recent entries

**Storage Location:** `/data/dreamer/notebooks/{user}.jsonl`

**Entry Schema:**
```json
{
  "id": "uuid",
  "kind": "video|note|dream|etc",
  "name": "entry title",
  "mood": "project or category",
  "text": "description or content",
  "tags": ["tag1", "tag2"],
  "links": [],
  "recordedAt": "ISO8601",
  "ternaryId": "unique-id",
  "private": true
}
```

### 3. DASHBOARD / UI FRAMEWORK ✅

**Dashboard Page:** `public/flourishing.html`

**Current Status:** BASIC
- UI exists
- Routes exist: `/api/flourishing/world/*`
- No Creator Suite integration
- No job/processing status
- No analytics

### 4. VIDEO PROCESSING (EXTERNAL) ⚠️

**Location:** Home directory `~/lantern_*.py`

**Variants:**
- V5: Basic video processing
- V6: Real editor with motion detection
- V7: Gaming edition with action detection
- V7++: Combat detector variant
- V7+++: Action-focused variant

**Capabilities (from V7 analysis):**
- FFmpeg integration (via imageio_ffmpeg)
- Video ingest and duration detection
- Motion/action detection
- Gaming-focused caption library
- Dynamic overlays
- Short-form export (1080x1920)

**Status:** EXTERNAL SCRIPTS
- Not integrated into platform
- Hardcoded file paths
- No API exposure
- No progress tracking
- No persistence of outputs

### 5. AI INTEGRATIONS ✅

**Available Services:**
- Dream Chat (multi-agent LLM selection)
- Provider routing (Anthropic, OpenAI, Gemini)
- Swarm orchestration
- Stream chat (SSE-based)

**Status:** AVAILABLE FOR INTEGRATION
- Can be leveraged for caption generation
- Can be used for viral scoring
- Can drive highlight detection prompts

### 6. AUTHENTICATION & SECURITY ⚠️

**User Model:** Normalized usernames (URL param: `?user=dreamer`)

**Current Gaps:**
- No authentication required for uploads
- No rate limiting
- No quota enforcement
- No access control

### 7. JOB SYSTEM ❌

**Status:** MISSING ENTIRELY

**Need to Build:**
- Job queue (JSONL or database)
- Worker processes for video processing
- Progress tracking
- Retry logic
- Error handling

---

## ROUTES AUDIT

### Dream Journal Routes

| Route | Method | Purpose | Status |
|-------|--------|---------|--------|
| `/api/dreamer` | GET | List all entries | ✅ Working |
| `/api/dreamer` | POST | Create entry (JSON) | ✅ Working |
| `/api/dreamer/upload` | POST | Upload with file | ✅ Working |
| `/api/dreamer/chat` | POST | Chat with entry | ✅ Working |
| `/api/agents` | GET | List agent personas | ✅ Working |

### Dashboard Routes

| Route | Method | Purpose | Status |
|-------|--------|---------|--------|
| `/flourishing` | GET | Dashboard UI | ✅ Working |
| `/api/flourishing/world/*` | GET | Dashboard data | ✅ Working |

### Missing Creator Suite Routes

| Route | Purpose | Priority |
|-------|---------|----------|
| `/creator` | Creator dashboard home | P0 |
| `/creator/uploads` | List uploads with status | P0 |
| `/creator/projects` | Manage creator projects | P1 |
| `/creator/exports` | Export variants and formats | P1 |
| `/creator/analytics` | View viral/retention scores | P2 |
| `/api/creator/jobs` | Job queue status | P0 |
| `/api/creator/analyze` | Start highlight analysis | P0 |
| `/api/creator/variants` | Generate A/B/C variants | P1 |
| `/api/creator/captions` | Generate captions | P1 |
| `/api/creator/export` | Generate short-form export | P1 |

---

## SERVICES AUDIT

### Existing Services (lib/)

| Service | Size | Purpose | Creator Relevance |
|---------|------|---------|-------------------|
| `dreamer-store.js` | 3.7K | Journal persistence | Foundation |
| `dream-chat.js` | 31K | LLM agent routing | Caption generation |
| `stream-chat.js` | 63K | SSE streaming | Progress updates |
| `file-queue.js` | 1.8K | JSONL append queue | Job persistence |
| `status.js` | 11K | System status | Job monitoring |
| `provider-router.js` | 9.6K | LLM provider selection | AI services |
| `image-generation.js` | 1.6K | Image gen client | Thumbnail generation |
| `swarm-orchestrator.js` | 16K | Agent coordination | Job orchestration |

### Missing Creator Services

| Service | Purpose | Effort |
|---------|---------|--------|
| `highlight-engine.js` | Motion/action detection | Medium |
| `caption-engine.js` | Dynamic caption generation | Medium |
| `retention-engine.js` | A/B/C variant generation | Medium |
| `viral-scorer.js` | Viral potential scoring | Small |
| `thumbnail-engine.js` | AI thumbnail generation | Small |
| `export-engine.js` | Short-form format export | Medium |
| `job-worker.js` | Background job processor | Medium |
| `safe-zone-detector.js` | Facecam/HUD preservation | Medium |

---

## RECOMMENDED TECH STACK

### Production Dependencies to Add

| Package | Purpose | Reason |
|---------|---------|--------|
| `fluent-ffmpeg` | FFmpeg abstraction | Video processing |
| `jimp` or `sharp` | Image processing | Thumbnail generation |
| `node-cron` | Job scheduling | Async processing |
| `uuid` | ID generation | Job/entry IDs |
| `pino` | Structured logging | Job tracking |

### System Dependencies

- **FFmpeg** — Video processing (highlights, exports, captions)
- **Python 3.8+** — For integration with V7 editor or reimplementation
- **libx264** — H.264 codec for shorts export

---

## CRITICAL GAPS

1. **No Background Job System** — Need async processing for videos
2. **No FFmpeg Integration** — Need Node.js wrapper for video processing
3. **No Highlight Detection** — Need motion/action/reaction analysis
4. **No Variant Generation** — Need A/B/C with different hooks/pacing
5. **No Export System** — Need multi-format short-form export
6. **No Analytics** — Need viral scoring, retention prediction
7. **No Creator UI** — Need full Creator Dashboard
8. **No Error Handling** — Current upload endpoint has gaps

---

## IMMEDIATE NEXT STEPS

1. Create branch: `feature/creator-suite-v9`
2. Build Phase 2 (V8 Highlight Engine):
   - FFmpeg integration
   - Video ingest
   - Motion detection baseline
3. Open focused PR with highlight engine
4. Continue phased approach for remaining phases
