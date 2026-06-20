# Dream Chat: Complete Claude Desktop Replacement

**Goal:** Make dream chat a direct, feature-complete replacement for Claude Desktop

**Status:** Planning Phase  
**Target:** Production-ready in 3-4 days

---

## Current State vs. Target

### What We Have
✅ Multi-turn conversation support  
✅ 6 agent personas (Lantern, Blinkbug, Keystone, Waterfall, Xenon, Founder)  
✅ Web search integration (MCP)  
✅ CSF memory integration  
✅ Trading context injection  
✅ Real-time streaming responses  
✅ Dark/light theme support  
✅ Responsive mobile design  

### What's Missing (Claude Desktop Features)
❌ Conversation history / sidebar  
❌ File uploads / attachments  
❌ Model selection dropdown  
❌ System prompt customization  
❌ Export conversations (PDF, markdown)  
❌ Quick settings panel  
❌ Keyboard shortcuts (Cmd+K search, Cmd+N new, etc)  
❌ Conversation search / filtering  
❌ Clear conversation button  
❌ Message editing/regeneration  
❌ Copy code blocks with syntax highlighting  

---

## Implementation Plan (4 Phases)

### Phase 1: UI/UX Overhaul (1 day)

**Sidebar Navigation**
- Left sidebar with conversation list
- "New conversation" button
- Search/filter conversations
- Delete conversation option
- Conversation timestamps

**Settings Panel**
- API key management (Anthropic, OpenAI, Gemini)
- Agent selection dropdown
- Temperature/maxTokens sliders
- System prompt editor
- Dark/light theme toggle
- Clear cache button

**Header**
- Current conversation title
- Agent selector (quick switch)
- Settings icon
- Export options

**Enhanced Message Display**
- Code syntax highlighting with copy button
- Markdown rendering (bold, italic, links, lists)
- Message timestamps
- Copy message button on hover
- Edit/regenerate on user messages

### Phase 2: Core Features (1.5 days)

**Conversation Management**
- Save conversations to localStorage
- Load from conversation list (sidebar)
- Auto-save as user types (local)
- Export as PDF
- Export as Markdown
- Share conversation (get download link)

**File Upload Support**
- Drag-and-drop file upload area
- Support for .txt, .pdf, .json, .csv, .md
- File preview before sending
- Attached files context in message

**Message Features**
- Edit user messages and regenerate
- Delete messages
- Regenerate last assistant message
- Copy message content
- Pin important messages

**Search & Navigation**
- Cmd+K to search conversations
- Cmd+N for new conversation
- Cmd+? for help/shortcuts
- Arrow keys to navigate messages
- Escape to close panels

### Phase 3: Advanced Features (1 day)

**Performance Monitoring**
- Show token count
- Display API cost estimate
- Latency indicator
- Provider indicator (which LLM responded)

**Context Management**
- Web search toggle (on/off)
- CSF memory toggle
- Trading context toggle
- Choose which agents can access which context

**Conversation Organization**
- Archive conversations (keep but hide)
- Star/favorite conversations
- Group by date/agent
- Filter by agent

### Phase 4: Polish & Testing (0.5 days)

**Quality**
- Mobile responsiveness audit
- Accessibility audit (WCAG 2.1)
- Performance optimization
- Cross-browser testing

**Documentation**
- User guide
- Keyboard shortcuts reference
- FAQ
- Video walkthrough

---

## File Changes

### New/Modified Files

```
dream-chat.html (expand from 1023 → ~2500 lines)
  ├── Sidebar component
  ├── Settings panel
  ├── File upload handler
  ├── Export functionality
  ├── Message editor
  └── Conversation manager

dream-chat.css (expand significantly)
  ├── Sidebar styles
  ├── Settings panel styles
  ├── Code syntax highlighting
  ├── Responsive layout adjustments
  └── Animation improvements

/lib/dream-chat.js (backend changes)
  ├── Add /api/conversations endpoint (list, create, delete, export)
  ├── Add /api/messages endpoint (get history, edit, delete)
  ├── Add /api/files endpoint (upload, process)
  ├── Add /api/export endpoint (PDF/markdown generation)
  └── Improve error handling

/routes/dream.js
  ├── Add conversation routes
  ├── Add file upload handler
  ├── Add export handler
  └── Add search endpoint
```

---

## Phase 1: UI/UX Overhaul Detailed Tasks

### Sidebar (500 lines)
- [ ] Conversation list component
- [ ] New conversation button + modal
- [ ] Search/filter input
- [ ] Delete conversation (with confirm)
- [ ] Conversation metadata (date, last message preview, agent used)
- [ ] Collapsible/responsive for mobile

### Settings Panel (400 lines)
- [ ] Modal/drawer design
- [ ] Tabs: API Keys, Preferences, Advanced
- [ ] API key inputs (Anthropic, OpenAI, Gemini, etc.)
- [ ] Sliders for temperature, maxTokens
- [ ] System prompt textarea
- [ ] Clear cache/memory button
- [ ] Export settings option

### Header Bar (200 lines)
- [ ] Title bar with current conversation name
- [ ] Quick agent selector dropdown
- [ ] Settings + export icons
- [ ] Mobile burger menu

### Enhanced Messages (300 lines)
- [ ] Code block rendering with syntax highlighting
- [ ] Markdown rendering
- [ ] Copy button on code blocks
- [ ] Timestamp display
- [ ] Message actions (edit, delete, copy)
- [ ] Loading skeleton for streaming

---

## Backend Changes

### New Endpoints

```javascript
// Conversation management
GET /api/dreams/conversations           // List all
POST /api/dreams/conversations          // Create new
GET /api/dreams/conversations/:id       // Get one
DELETE /api/dreams/conversations/:id    // Delete
PATCH /api/dreams/conversations/:id     // Update metadata

// Message management  
GET /api/dreams/conversations/:id/messages   // Get all
POST /api/dreams/conversations/:id/messages  // Add message
PATCH /api/dreams/messages/:id               // Edit message
DELETE /api/dreams/messages/:id              // Delete message

// File handling
POST /api/dreams/files                  // Upload file
GET /api/dreams/files/:id               // Get file info

// Export
POST /api/dreams/conversations/:id/export // PDF or markdown
```

---

## Success Criteria

✅ Feature parity with Claude Desktop (basic features)  
✅ Conversation persistence (localStorage or server)  
✅ File upload working  
✅ All keyboard shortcuts functioning  
✅ Responsive on mobile/tablet/desktop  
✅ Accessible (WCAG 2.1 AA)  
✅ <2 second load time  
✅ Zero "open Claude Desktop" need  

---

## Why This Matters

**Current state:** Users have dream chat but fall back to Claude Desktop for:
- Conversation history
- File uploads
- Quick agent switching
- Export/sharing

**After this:** Dream chat is COMPLETE. No reason to open Claude Desktop ever again.

This positions Lantern OS as:
- Standalone local-first chat tool ✓
- Convergence IO frontend ✓
- Personal AI research platform ✓

All via a single, beautiful interface.

---

## Timeline

```
Day 1: Sidebar + Settings + Header (Phase 1)
  Jun 12 (afternoon after Three-Doors intake)

Day 2: Conversation management + file upload (Phase 2, part 1)
  Jun 13

Day 3: Message features + search + keyboard shortcuts (Phase 2, part 2)
  Jun 14

Day 4: Advanced features + export + polish (Phase 3 + 4)
  Jun 15

Launch: Production-ready dream chat (no Claude Desktop needed)
  Jun 15 EOD
```

---

## Notes

- Use localStorage for conversation persistence (no server DB needed yet)
- Keep localStorage <5MB by archiving old conversations
- Use service worker for offline mode
- Implement conversation sync (optional: to local file)
- Add dark mode preference detection
- Markdown rendering via marked.js (lightweight)
- Code syntax highlighting via Prism.js (lightweight)

This is the final piece to make Lantern OS a complete Claude Desktop replacement. 🚀
