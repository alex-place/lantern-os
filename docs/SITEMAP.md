---
author: Alex Place
created: 2026-06-11
updated: 2026-06-20
---

# Keystone OS Sitemap

Complete navigation map of Keystone OS local-first personal operating system. All pages run locally, no account required.

---

## 🏠 Home & Navigation

### Entry Points
- **Home Page** — `/index.html`
  - Main landing page with hero, feature overview, and status dashboard
  - Primary CTA: Open Journal
  - Secondary panels: Kingdome, System Status, Agent Leaderboard, Dashboard, Trading, Settings, Help

---

## 📔 Core Features

### 1. Dream Journal
- **Main Chat Interface** — `/dream-chat.html`
  - Write and reflect on dreams, thoughts, reflections
  - AI chat with configurable personas (Lantern, Blinkbug, Keystone, Waterfall, Xenon, Founder)
  - Real-time streaming responses
  - Local persistence, no cloud required
  
- **Full Journal Archive** — `/dream-journal/index.html`
  - Deep archive and advanced synthesis
  - Patreon supporters only

---

## 🏯 Interactive Experiences

### 2. Three-Doors Kingdome
- **Main Interface** — `/three-doors.html`
  - Seven-stage infinitely replayable dream journey
  - Three doors per scene — no wrong choices
  - Personalized by archetype/agent/symbols
  - Convergence loop integration
  - Phase 4 complete: narration, SD prompts, full integration

**Phases Completed:**
- Phase 0: Initialization
- Phase 1: CSF Backend Integration
- Phase 2: Breadcrumbs & stage tracking
- Phase 3: Personalized Door Generation
- Phase 4: Narration & SD image prompts

---

## 📊 Data & Monitoring

### 3. Dashboard
- **Main Dashboard** — `/flourishing`
  - Personal spaces and community hub
  - Reference data and analytics
  - Private by default, shareable on demand
  - HFF (Human Flourishing Frameworks) integration

### 4. System Status
- **Agent Status & Monitoring** — `/agent-status.html`
  - Live system health
  - Agent roster and work slots
  - Action capabilities
  - Performance metrics

### 5. Agent Leaderboard
- **Performance Leaderboard** — `/leaderboard`
  - Real-time agent performance metrics
  - Task type breakdown
  - Convergence loop results
  - Agent comparison and ranking

---

## 💰 Trading & Markets

### 6. Lantern Trader Dashboard
- **Main Trading UI** — `/kalshi-terminal.html`
  - Real-time market zones and support/resistance levels
  - Watchlist price monitoring (SPY, AAPL, TSLA, NVDA, AMD)
  - Live positions and account equity
  - Market status (VIX, market hours, day P&L)
  - Agent log and recent orders
  - Zone ladder visualization
  - Dark theme, responsive design
  - Single-app architecture (no external services)

**Integration Status:**
- ✅ Phase 2a: UI & wrapper framework
- ✅ Phase 2b: Python CLI bridge complete
- ✅ Phase 2c: Route refactoring complete
- ⏳ Phase 2d: Live testing with Alpaca credentials

**Related Legacy Pages:**
- `/trading.html` — Legacy AI Trader dashboard proxy
- `/trading-news.html` — Legacy trading news feed

---

## ⚙️ Settings & Configuration

### 7. AI Provider Configuration
- **Provider Settings** — `/settings/providers.html`
  - Configure Claude (Anthropic)
  - Configure Gemini (Google)
  - Configure OpenAI
  - Optional — works without any key
  - Local key storage

---

## 📚 Help & Documentation

### 8. Knowledge Center
- **Help & Guides** — `/knowledgecenter.html`
  - Getting started guide
  - What's new
  - FAQ
  - Common questions
  - Troubleshooting

### 9. Changelog
- **Version History** — `/changelog.html`
  - Release notes
  - Feature announcements
  - Bug fixes
  - Deprecations

---

## 🔗 API Endpoints

### REST API Routes

#### Dream Journal APIs
- `POST /api/dream/create` — Create new dream entry
- `GET /api/dream/read/{id}` — Read specific dream
- `GET /api/dream/greet` — Get agent greeting
- `GET /api/dream/stream` — SSE streaming endpoint for chat
- `GET /api/dream/search/web` — Web search grounding

#### Agent & System APIs
- `GET /api/agent/health` — Agent health check
- `GET /api/agent/inspect` — Agent inspection data
- `GET /api/status` — System status
- `GET /api/readiness` — Readiness check
- `GET /api/mining-lab/status` — Mining lab status

#### Trading APIs (Local Trader Integration)
- `GET /api/trading/zones` — Market zones (support/resistance)
- `GET /api/trading/watchlist-prices` — Live watchlist prices
- `GET /api/trading/positions` — Open positions + account
- `GET /api/trading/market-status` — VIX, market hours, P&L
- `GET /api/trading/agent-log` — Trading activity log
- `GET /api/trading/orders` — Recent orders (GET)
- `POST /api/trading/orders` — Record orders (POST)
- `POST /api/trading/agent-log` — Record trading activity (POST)

#### Trading Memory APIs (CSF Integration)
- `GET /api/trading/dashboard/orders` — Local order history
- `GET /api/trading/dashboard/agent-log` — Local agent log
- `GET /api/trading/dashboard/positions` — Dashboard positions
- `GET /api/trading/dashboard/market-status` — Dashboard market status
- `GET /api/trading/dashboard/zones` — Dashboard zones
- `GET /api/trading/dashboard/watchlist-prices` — Dashboard prices

#### Kingdome APIs
- `GET /api/three-doors/state` — Current game state
- `POST /api/three-doors/choice` — Record door choice
- `GET /api/three-doors/image` — Generated door images
- `POST /api/three-doors/narration` — Get AI narration

#### CSF (Convergence-Fitted Searchable Format) APIs
- `GET /api/csf/search` — Search CSF memory database
- `POST /api/csf/ingest` — Ingest data into CSF
- `GET /api/csf/export` — Export CSF records

#### UI & Settings APIs
- `GET /api/ui/theme` — Get current theme
- `POST /api/ui/theme` — Save theme preference
- `GET /api/ui/settings` — Get UI settings

#### File & RAG APIs
- `GET /repo/{path}` — Serve repo files (read-only, filtered)
- `GET /view?path={path}` — View markdown/text files
- `GET /api/rag/house` — RAG document house builder
- `POST /api/operator/queue` — Task intake

#### Three-Doors Image Pool
- `GET /api/three-doors/image-pool` — Image pool status
- `POST /api/three-doors/image-pool` — Add images to pool

#### Self-Edit APIs
- `GET /api/self-edit/status` — Self-edit status
- `POST /api/self-edit/apply` — Apply code edits

#### Performance & Leaderboard
- `GET /api/agent-performance/stats` — Performance stats
- `GET /api/leaderboard` — Agent leaderboard
- `GET /api/leaderboard/by-task-type` — Performance by task type

#### Surfaces & Exploration
- `GET /api/surfaces` — Available surfaces
- `POST /api/surfaces/create` — Create surface

---

## 📁 Static Assets

### CSS
- `/css/site.css` — Main site stylesheet
- `/css/theme.css` — Theme variables and toggles

### JavaScript
- `/js/theme-toggle.js` — Dark/light mode toggle
- `/js/site.js` — Site-wide utilities
- `/js/markdown-render.js` — Markdown rendering

### Fonts
- Google Fonts: IBM Plex Mono, IBM Plex Sans
- CSS @import from fonts.googleapis.com

---

## 🔐 Security & Privacy

### Key Security Features
- ✅ No tracking, no ads, no data sold
- ✅ Runs entirely on local machine
- ✅ No internet required for core features
- ✅ Input validation at system boundaries
- ✅ CORS headers for cross-origin requests
- ✅ CSP headers for script sandboxing

### Sensitive Endpoints (Protected)
- AI Provider keys: Local storage only, never transmitted
- User journal data: Stored in `data/` directory, excluded from git
- CSF memory: Binary format with access control

---

## 🎯 Navigation Hierarchy

```
Home (/)
├── Start Here
│   └── Dream Journal (/dream-chat.html)
│
├── Kingdome
│   ├── Three-Doors Journey (/three-doors.html)
│   ├── System Status (/agent-status.html)
│   ├── Agent Leaderboard (/leaderboard)
│   ├── Dashboard (/flourishing)
│   ├── Full Journal (/dream-journal/index.html)
│   ├── Trading (/kalshi-terminal.html)
│   └── Settings (/settings/providers.html)
│
├── Help & Support
│   ├── Knowledge Center (/knowledgecenter.html)
│   └── Changelog (/changelog.html)
│
└── External
    ├── GitHub (https://github.com/alex-place/lantern-os)
    └── Patreon (https://www.patreon.com/c/lanterndreamjournal)
```

---

## 📱 Responsive Design

All pages are built with:
- Mobile-first responsive design
- Dark/light theme toggle
- Accessible WCAG guidelines
- Touch-friendly interactions
- Works offline for core features

---

## 🚀 Performance

### Caching Strategy
- CSF memory: 30s-60s TTL (configurable)
- Trader agent: 30-60s caching per endpoint
- Browser cache: No-store for dynamic data
- Local file cache: JSONL append queues for thread safety

### Load Times
- Home page: <100ms (static HTML)
- Journal chat: ~200ms (SSE streaming)
- Kingdome: <500ms (offline capable)
- Trader dashboard: 3-5s first call (Python startup), <100ms cached

---

## 📝 Content Types

### Supported Formats
- **Dreams**: JSONL per user (text, metadata, lucidity, clarity)
- **Conversations**: JSONL lines (timestamp, agent, text, model, tokens)
- **CSF Memory**: Binary searchable format with Tier system
- **Markdown**: Rendered in `/repo/` and `/view` endpoints
- **Images**: Three-Doors image pool, generated via SD/DALL-E

---

## 🔄 Data Flow

```
User Input
    ↓
[Dream Chat] → AI Response (SSE Streaming)
[Three-Doors] → Game State + Narration
[Trading] → Market Data (Python → JSON)
    ↓
Local Storage (JSONL / CSF)
    ↓
RAG House / Search
    ↓
Display to User
```

---

## 🎓 Related Documentation

- `CLAUDE.md` — Developer instructions
- `QUICKSTART.md` — Setup guide
- `AGENTS.md` — Agent architecture
- `PROVIDERS.md` — AI provider configuration
- `SECURITY.md` — Security best practices
- `SKILLS.md` — Available capabilities
- `TRADER-PHASE2b-COMPLETE.md` — Trading integration details
- `TRADER-PHASE2-PROGRESS.md` — Trading roadmap

---

## 📊 Status Dashboard (Live)

See `/index.html` status section for:
- Feature readiness (Ready, Optional, Coming Later)
- Real-time system health
- Agent performance metrics
- Recent journal entry previews

---

**Last Updated:** 2026-06-12  
**Version:** Orion Edition  
**Status:** Core features stable, trading phase 2b complete, kingdome phase 4 complete
