# unisona.ai UX Simplification Plan — Make It Work for Normies

## The Problem

Current unisona.ai chat requires users to understand:
- "Skills" (what are they? when do I use them?)
- "Σ₀" (no idea what this means)
- "CSF Memory" (jargon)
- "Convergence" (abstract concept)
- "Context Modes" (overwhelming list)
- Multiple AI providers (Auto, Claude, ChatGPT, Gemini, Grok, Local, unisona.ai FT)

**Result:** Non-technical users feel lost immediately. UI assumes programming knowledge.

---

## Phase 1: First-Load Experience (Week 1)

### 1.1 Guided Onboarding Modal

On first visit, show:
```
"What would you like to do?"

[ 📝 Chat (Journal)      ] — Talk about your day
[ 💻 Code (Dev)          ] — Ask for code help
[ 🔍 Research (Explore)  ] — Learn something new
[ 💰 Trading (Trader)    ] — Market analysis
```

NO jargon. NO advanced options. Just four simple choices.

**Implementation:**
- Check `localStorage.lantern-hasSeenOnboarding`
- Show modal if false
- Set flag to true on click
- Route starter prompt based on choice

### 1.2 Provider Selection Simplified

**Current:** Dropdown with 7 options
**New:** Three radio buttons:

```
( ) Auto (I don't know — pick the best)
( ) Fast (Local, no API needed)
( ) Smart (Use my API key for best results)
```

**Hide:** All individual provider settings until user selects "Smart"

---

## Phase 2: Remove Jargon (Week 1-2)

### 2.1 Rename UI Elements

| Current | New | Why |
|---------|-----|-----|
| CSF Memory / Symbols | Remember Important Things | Clear purpose |
| Context Modes | Give AI Context | Plain English |
| Convergence | — | Hide entirely from normies |
| Σ₀ | — | Remove from UI |
| Skills | Quick Actions | More intuitive |
| Connectors | Tools | Familiar term |
| Performance Monitor | Show stats | Optional, clear intent |

### 2.2 Add Help Bubbles

Every setting gets a `?` icon with one-sentence explanation:

```
"AI Provider" ?
↓
"Chooses which AI assistant to use. Auto picks
 the best for your question. Smart uses your
 paid API keys for faster responses."
```

No multi-line explanations. One sentence max.

### 2.3 Hide Power User Settings

Add toggle: **"Show Advanced Settings"** in settings drawer

**Basic view (default):**
- AI Provider (Auto / Fast / Smart)
- Theme (Light / Dark)
- Voice Mode (on/off)

**Advanced view (when toggled):**
- Individual provider keys (Claude, Gemini, ChatGPT, Grok)
- Context Modes (all checkboxes)
- Connectors (MCP, Web Search)
- Performance Monitor
- Convergence Settings (for power users)

---

## Phase 3: Intelligent Defaults (Week 2)

### 3.1 Auto-Detect What User Needs

Listen to first message, pick relevant context:

```
User says: "help me debug this" → Enable Code Context
User says: "should I buy..." → Enable Trading Context
User says: "what happened today" → Enable Web Search
User says: "remember..." → Enable Memory Mode
```

**No user action needed.** Context activates automatically based on intent.

### 3.2 Simplified Starter Prompts

**Current:**
```
⚡ What needs doing?
⚡ How's the system?
⚡ Get started
⚡ Tell me a story
⚡ Teach me
⚡ Play game
```

**New (dynamic based on onboarding choice):**

**Chat mode:**
```
⚡ What's on your mind?
⚡ Tell me about your day
⚡ Any questions?
```

**Code mode:**
```
⚡ Fix a bug for me
⚡ Explain this code
⚡ Design a feature
```

**Research mode:**
```
⚡ Teach me something
⚡ Explain how this works
⚡ Search for me
```

**Trading mode:**
```
⚡ Should I buy/sell?
⚡ Analyze this market
⚡ Trading ideas
```

---

## Phase 4: Settings Restructure (Week 2-3)

### 4.1 Settings Modal Redesign

**Tabs:**
- **General** (Theme, Voice, Provider)
- **Connected Services** (API keys, Tools)
- **Advanced** (Context modes, Convergence, Monitoring)

**Each tab = one concept.** No overwhelming lists.

### 4.2 Progressive Disclosure

Show only what user needs:

1. **First load:** Just AI Provider + Theme
2. **After first message:** Show Voice, Context Mode (if relevant)
3. **After 10 messages:** Show Advanced if they ask

Use `localStorage` to track usage patterns.

---

## Phase 5: One-Click Setup (Week 3)

### 5.1 Provider Setup Wizard

Instead of: "Enter your ANTHROPIC_API_KEY"
Use: 
```
"Get smarter responses"
  ↓
"Enter Claude API key" (or skip to use free option)
  ↓
[Paste key]
[Test key]
[Done]
```

Show a **✓** when key is valid.

### 5.2 Pre-Fill Common Actions

Instead of typing, offer:
```
Quick Actions:
☑ Chat with me
☑ Help with code
☑ Research
☑ Trade ideas
☑ Custom question
```

User clicks, AI responds without typing.

---

## Phase 6: Feedback & Help (Week 4)

### 6.1 Contextual Tips

Show tips when user gets stuck:

```
No message for 2 min?
↓
💡 Tip: Try "Tell me about your day" or 
   ask me to explain something
```

### 6.2 Help Button

Single "?" button in nav → simplified help overlay:

```
What is unisona.ai?
  → An AI assistant that remembers you

How do I use it?
  → Just chat like normal. Ask for help.

What if I have a problem?
  → Click "Help" below, or email help@lantern-os.net
```

---

## Phase 7: Mobile Optimization (Week 4)

### 7.1 Touch-Friendly Settings

- Larger buttons (48px minimum)
- Swipe-to-toggle instead of checkboxes
- Bottom sheet drawer instead of modal

### 7.2 Reduced Settings on Mobile

Hide advanced settings entirely on phone. Only show:
- AI Provider
- Theme
- Voice Mode

Access advanced via "More Settings" button.

---

## Implementation Checklist

- [ ] **Phase 1:** First-load onboarding modal (4h)
- [ ] **Phase 1:** Simplified provider selection (2h)
- [ ] **Phase 2:** Rename UI elements in HTML (1h)
- [ ] **Phase 2:** Add help bubbles to settings (3h)
- [ ] **Phase 2:** Add "Show Advanced Settings" toggle (2h)
- [ ] **Phase 3:** Auto-detect user intent (4h)
- [ ] **Phase 3:** Dynamic starter prompts (2h)
- [ ] **Phase 4:** Redesign settings with tabs (4h)
- [ ] **Phase 5:** Provider setup wizard (4h)
- [ ] **Phase 5:** Pre-fill quick actions (3h)
- [ ] **Phase 6:** Contextual help & tips (3h)
- [ ] **Phase 7:** Mobile optimization (5h)

**Total: ~40 hours of work**

---

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|-----------------|
| First-time confusion | <2 min to first message | Analytics: time to first send |
| Provider selection | 80% use "Auto" | localStorage preference logging |
| Help button clicks | <5% of users | Click tracking |
| Mobile UX rating | 4.5+ stars | In-app feedback survey |
| Setup time | <1 minute | Timed user testing |

---

## Rollout Strategy

### Week 1: Core UX
- Onboarding modal
- Simplified provider selection
- Dark mode (done in #641)

### Week 2: Jargon Removal + Defaults
- Rename all elements
- Help bubbles
- Auto-detection
- Dynamic prompts

### Week 3: Settings Overhaul
- Tab-based settings
- Progressive disclosure
- Wizard for API keys

### Week 4: Polish + Mobile
- Help system
- Mobile optimization
- User testing feedback

---

## Design Principles

1. **One choice at a time** — Don't show all options upfront
2. **Clear language** — No jargon. No abbreviations (except common ones)
3. **Smart defaults** — Make the 80% case work without config
4. **Progressive disclosure** — Show advanced features only to power users
5. **Mobile-first** — Works great on phone, even better on desktop
6. **Help nearby** — Questions answered in the UI, not in docs
7. **Quick setup** — Working in <1 minute without reading docs

---

## Related Issues

- #641 — Dark mode (✅ DONE)
- #642 — This epic (unisona.ai UX simplification)
- Future: Onboarding modal
- Future: Settings redesign
- Future: Mobile optimization

---

## Open Questions

- Should "Skills" be hidden entirely for normies? (Yes, hide them)
- Which AI provider should be default? (Claude, with fallback to Gemini)
- How many starter prompts? (3-4 max per mode)
- Should we track user behavior? (Yes, anonymously, for analytics)

---

## Notes for Implementer

- Use feature flags to roll out gradually
- Test with non-technical user (ask a friend)
- Measure time-to-first-message for each iteration
- Get feedback before building the full wizard
- Mobile testing is mandatory (use device emulator)

This is a **user-first** redesign. Every decision should ask: "Does a non-technical person understand this?"
