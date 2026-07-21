// ── Σ₀ operator-view gate (#2332) ────────────────────────────────────────────
// The Σ₀ groundedness/council apparatus ("✓ Σ₀", "⚠ ungrounded", "🌐 Ground this",
// "⚠ Σ₀ seam-open") is operator tooling. To a first-time consumer these badges read
// as errors/warnings tacked onto the AI's answer. Only surface them to operators
// (admin / tech_support, or the auth-gate's body.is-admin class); consumers still get
// plain-language honesty notes and functional auto-verification.
function isSigma0OperatorView() {
  try {
    const role = (typeof lanternSession === 'object' && lanternSession) ? lanternSession.role : '';
    if (role === 'admin' || role === 'tech_support') return true;
    if (typeof document !== 'undefined' && document.body && document.body.classList.contains('is-admin')) return true;
  } catch { /* fail closed to consumer view */ }
  return false;
}

// ── Deterministic tool-flow persistence (#1268) ──────────────────────────────
// Image/video/vision/doc-gen requests are handled entirely client-side (no LLM
// call), so they never hit /api/dream/chat — which means they never reached the
// server's appendConversationEntry either. A reload or session-switch replayed
// from server storage and these turns just vanished. POST them directly to the
// existing /api/conversations endpoint so they survive like normal chat turns.
function persistToolTurn(role, text, meta) {
  if (!text) return;
  try {
    const sessionId = localStorage.getItem('lantern_chat_session') || null; // #1268
    fetch('/api/conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, text, surface: 'garage', sessionId, ...(meta ? { meta } : {}) }),
    }).catch(() => {}); // best-effort — a failed persist must never break the live reply
  } catch { /* best-effort */ }
}

// ── Tool-turn replay (#1270) ─────────────────────────────────────────────────
// Rebuild the rich bubble content (generated image, YouTube embed, document
// download) from a persisted meta.tool payload, so reloading or switching back to
// a session restores the actual element — not just its text description. These are
// the outputs of the model's native tool calls (generate_image, web_search,
// generate_document). Returns inner-HTML for the .bubble, or null to fall back to text.
function renderToolReplay(tool) {
  if (!tool || !tool.kind) return null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (tool.kind === 'image' && tool.url) {
    const caption = tool.label
      || (`Image of <b>${esc(tool.prompt || '')}</b>` + (tool.note ? ` <span style="opacity:.55;font-size:11px">· ${esc(tool.note)}</span>` : '') + ':');
    return `${caption}<img src="${esc(tool.url)}" alt="${esc(tool.prompt || 'image')}" referrerpolicy="no-referrer" `
      + `style="max-width:100%;border-radius:8px;margin:6px 0;display:block">`;
  }
  if (tool.kind === 'youtube' && (tool.query || tool.url)) {
    const q = encodeURIComponent(tool.query || '');
    const embed = `https://www.youtube-nocookie.com/embed?listType=search&list=${q}`;
    const searchUrl = tool.url || `https://www.youtube.com/results?search_query=${q}`;
    return `Here are videos for <b>${esc(tool.query || '')}</b>:`
      + `<iframe src="${esc(embed)}" width="100%" height="240" style="border:0;border-radius:8px;margin:6px 0;max-width:480px;display:block" `
      + `allow="encrypted-media;picture-in-picture" allowfullscreen loading="lazy"></iframe>`
      + `<a href="${esc(searchUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline">▶ Open these results on YouTube ↗</a>`;
  }
  if (tool.kind === 'document' && tool.url) {
    const kb = tool.bytes ? ' · ' + Math.round(tool.bytes / 1024) + ' KB' : '';
    return `✓ Generated <b>${esc(tool.title || 'document')}</b> <span style="opacity:.6;font-size:11px">(${esc(tool.format || '')}${kb})</span><br>`
      + `<a href="${esc(tool.url)}" download="${esc(tool.filename || '')}" style="display:inline-block;margin-top:6px;padding:6px 12px;border:1px solid var(--accent,#06b6d4);border-radius:8px;color:var(--accent,#06b6d4);text-decoration:none;font-weight:600">⬇ Download ${esc(tool.filename || 'file')}</a>`;
  }
  if (tool.kind === 'embed' && tool.src) {
    // Same allowlist as the live summoner — a persisted row must not become a
    // framing sink if the store is ever tampered with.
    const okSrc = /^\/[^/]/.test(tool.src) || /^https:\/\/(archive\.org|[a-z0-9-]+\.github\.io|www\.youtube(?:-nocookie)?\.com|player\.vimeo\.com)\//i.test(tool.src);
    if (!okSrc) return null;
    const icon = tool.embedKind === 'listen' ? '📻' : tool.embedKind === 'watch' ? '🎬' : '🕹️';
    const verb = tool.embedKind === 'watch' ? 'Now showing' : 'Now playing';
    const h = Math.max(160, Math.min(640, Number(tool.height) || 360));
    return `<div class="chat-embed" style="border:1px solid var(--border,#2a2a3a);border-radius:10px;overflow:hidden;max-width:480px">`
      + `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(92,200,255,.10);color:var(--accent,#5cc8ff);font-weight:600;font-size:12.5px"><span aria-hidden="true">${icon}</span><span>${verb} — ${esc(tool.title || 'embed')}</span></div>`
      + `<iframe src="${esc(tool.src)}" style="width:100%;height:${h}px;border:0;display:block" title="${esc(tool.title || 'embed')}" allow="autoplay; fullscreen; gamepad" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-pointer-lock"></iframe>`
      + (tool.lore ? `<div style="padding:6px 10px;font-size:11px;opacity:0.6;border-top:1px solid var(--border,#2a2a3a)">${esc(tool.lore)}</div>` : '')
      + `</div>`;
  }
  return null;
}
window.renderToolReplay = renderToolReplay;

// ── Personal Cube Integration ────────────────────────────────────────────────
let personalContext = null;

function sanitizePersonalContext(context) {
  if (!context || typeof context !== 'object') return {};
  const allowedFields = ['github', 'providers', 'environment', 'priorities', 'timestamp'];
  const sanitized = {};
  for (const field of allowedFields) {
    if (context[field] !== undefined) sanitized[field] = context[field];
  }
  delete sanitized.error;
  return sanitized;
}

async function loadPersonalCube() {
  try {
    const resp = await fetch('/api/cubes/alex/personal', { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      personalContext = await resp.json();
    } else {
      personalContext = { error: 'API unavailable', timestamp: new Date().toISOString() };
    }
  } catch (e) {
    personalContext = { error: 'Network error', timestamp: new Date().toISOString() };
  }
}

loadPersonalCube();

function startVoiceInput() {
  if (!window.voiceMode || !window.recognition) return;
  try { window.recognition.start(); } catch (e) { console.error('Failed to start recognition:', e); }
}

// ── Cube delta writer ─────────────────────────────────────────────────────────
async function writeCubeDelta(eventType, symbols, payloadRef) {
  try {
    await fetch('/api/cubes/alex/delta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_surface: 'journal',
        event_type: eventType,
        symbols: symbols || [],
        payload_ref: payloadRef || '',
      }),
    });
  } catch (e) { /* silent — cube is best-effort */ }
}

// Broken / hallucinated image URLs used to hide themselves with display:none.
// When the answer is image-ONLY (model replied with just `![alt](url)`), that
// left a completely blank bubble — "the answer came through but the chat bubble
// is hidden". Swap the dead <img> for a visible fallback link so the answer is
// never invisible: alt text (if any) + a tap-to-open link to the source URL.
function lanternImgFallback(img) {
  try {
    const url = img.getAttribute('src') || '';
    const alt = (img.getAttribute('alt') || '').trim();
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.cssText = 'display:inline-block;color:var(--accent);text-decoration:underline;word-break:break-all;font-size:13px;margin:6px 0';
    a.textContent = '🖼️ ' + (alt ? alt + ' — ' : '') + 'image (tap to open)';
    img.replaceWith(a);
  } catch (e) {
    img.style.display = 'none';
  }
}

// ── Markdown + PR link renderer ───────────────────────────────────────────────
// #930: scheme allowlist for any URL we interpolate into href/src. The capture
// regexes below already require an http(s) scheme, so this is defense-in-depth
// (parity with markdown-render.js's safeUrl from #934) — a future loosening of a
// regex can't turn into a javascript:/data: sink. Non-allowed schemes neutralize
// to '#'.
function safeUrl(url) {
  const u = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[#/]/.test(u)) return u;                 // in-page anchor / site-absolute path
  return '#';
}

// ── Tool-call rendering ──────────────────────────────────────────────────────
// The local Σ₀ Ouro coder (FC adapter) answers tool-worthy turns with a
// <tool_call>{"name","input"}</tool_call> block. Render it as a card instead of
// leaking raw JSON. A matching `tool` SSE event (server-side execution) fills the
// result slot; see the stream handler.
function parseToolCallInner(inner) {
  try { const o = JSON.parse(inner); if (o && o.name) return o; } catch {}
  const nameM = inner.match(/"name"\s*:\s*"([^"]+)"/);
  let input = {};
  const inputM = inner.match(/"(?:input|arguments)"\s*:\s*(\{[\s\S]*\})/);
  if (inputM) { try { input = JSON.parse(inputM[1]); } catch {} }
  return nameM ? { name: nameM[1], input } : null;
}
function buildToolCard(inner, partial) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tc = parseToolCallInner(inner);
  const name = tc && tc.name ? tc.name : 'tool';
  const args = esc(tc && tc.input ? JSON.stringify(tc.input, null, 2) : inner.trim());
  const status = partial ? ' …calling' : '';
  // Collapsed by default (<details> with no `open`): a tool call isn't typically
  // something the user needs to read — they click the summary to expand args+result.
  return '<details class="tool-call-card" data-tool="' + esc(name) + '" style="border:1px solid var(--border,#2a2a3a);border-radius:10px;margin:8px 0;overflow:hidden">'
    + '<summary style="cursor:pointer;display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(92,200,255,.10);color:var(--accent,#5cc8ff);font-weight:600;font-size:13px;list-style:none">🔧 ' + esc(name) + '<span class="tcc-status" style="opacity:.7;font-weight:400">' + status + '</span></summary>'
    + '<pre style="margin:0;padding:8px 10px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--text,#cdd)">' + args + '</pre>'
    + '<div class="tcc-result" style="display:none;border-top:1px solid var(--border,#2a2a3a);padding:8px 10px;white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--muted,#9aa)"></div>'
    + '</details>';
}
function fillToolSlot(slot, evt) {
  if (!slot) return;
  const card = slot.closest('.tool-call-card');
  const statusEl = card && card.querySelector('.tcc-status');
  if (evt.ok) {
    slot.textContent = '↳ ' + String(evt.result ?? evt.preview ?? '');
    slot.style.color = 'var(--text,#cdd)';
    slot.style.opacity = '1';
    if (statusEl) { statusEl.textContent = ' ✓'; statusEl.style.color = '#4ade80'; }
  } else {
    const msg = ({
      disabled: 'tool execution is off (set CHAT_TOOL_EXEC=1)',
      auth: 'this tool needs operator access',
      unsafe: 'command not allowlisted',
      unknown: 'unknown tool',
    })[evt.reason] || ('tool error: ' + String(evt.result || evt.reason || 'failed'));
    slot.textContent = '⚠ ' + msg;
    slot.style.color = 'var(--muted,#9aa)';
    slot.style.opacity = '0.7';
    if (statusEl) { statusEl.textContent = ' ⚠'; statusEl.style.color = '#f87171'; }
  }
  slot.style.display = 'block';
}
function renderMarkdown(text) {
  // The [DOORS:…] tag is a Three-Doors CONTROL marker (door chips are parsed from
  // the raw text elsewhere) — never part of the prose. Strip it here, in the one
  // renderer, so every path shows the same clean text: streaming, finalize, and
  // history replay of persisted messages that still carry it (#2497).
  text = String(text ?? '').replace(/\[DOORS:[^\]]*\]?/gi, '').trimEnd();
  // Extract tool-call blocks (closed, then a trailing unclosed one while streaming)
  // into placeholders that survive HTML-escaping; restore as cards at the very end.
  const _toolCards = [];
  text = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (_, inner) => '\x00T' + (_toolCards.push(buildToolCard(inner, false)) - 1) + '\x00');
  text = text.replace(/<tool_call>\s*([\s\S]*)$/i, (_, inner) => '\x00T' + (_toolCards.push(buildToolCard(inner, true)) - 1) + '\x00');
  let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Fenced code → stash as a single placeholder so its newlines survive the block/line
  // pass below (which would otherwise split it across "lines" and mangle the code).
  const _code = [];
  h = h.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => '\x00C' + (_code.push('<pre class="code-block"><code>' + code + '</code></pre>') - 1) + '\x00');
  h = h.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italics: *text* / _text_ — but not list bullets ("* " has a space after) nor
  // intra-word underscores (snake_case). The negative lookahead on the opener (?!\s)
  // keeps "* item" from being read as an italic open.
  h = h.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
  h = h.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>');

  // Stash rich media + links as placeholders BEFORE the URL linkifiers run, so those
  // never touch a URL that's already inside an image / iframe / anchor.
  const _stash = [];
  const _put = (html) => `\x00L${_stash.push(html) - 1}\x00`;

  // Images ![alt](url) → <img>. Broken / hallucinated URLs fall back to a visible
  // link (see lanternImgFallback) instead of vanishing — so an image-only answer
  // never renders as a blank bubble. Must run before the link rule so ![..](..)
  // isn't read as a text link.
  // URL accepts http(s) OR a site-absolute /path (e.g. /media/… thumbnails); safeUrl gates both.
  h = h.replace(/!\[([^\]\n]*)\]\(((?:https?:\/\/|\/)[^\s)"]+)\)/g, (_, alt, url) =>
    _put(`<img src="${safeUrl(url)}" alt="${alt.replace(/"/g, '&quot;')}" loading="lazy" referrerpolicy="no-referrer" onerror="lanternImgFallback(this)" style="max-width:100%;border-radius:8px;margin:6px 0;display:block">`));

  // YouTube links → privacy-friendly inline embed.
  h = h.replace(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})[^\s<>"')\x00]*/g, (_, vid) =>
    _put(`<iframe src="https://www.youtube-nocookie.com/embed/${vid}" width="100%" height="220" style="border:0;border-radius:8px;margin:6px 0;max-width:480px;display:block" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`));

  // Wiki-style [[label]](url) — some models double the brackets; collapse to one
  // anchor. Must run before the single-bracket rule (whose label class excludes ']'
  // so it can't match a doubled bracket) or the doubled form renders as raw text.
  h = h.replace(/\[\[([^\]\n]+)\]\]\(((?:https?:\/\/|\/)[^\s)"]+)\)/g, (_, label, url) =>
    _put(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline">${label}</a>`));

  // Markdown links [label](url) → new-tab anchors.
  h = h.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^\s)"]+)\)/g, (_, label, url) =>
    _put(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline">${label}</a>`));

  h = h.replace(
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g,
    '<a href="https://github.com/$1/$2/pull/$3" target="_blank" rel="noopener" class="pr-pill">🔗 PR #$3 — $1/$2 →</a>'
  );
  h = h.replace(
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/g,
    '<a href="https://github.com/$1/$2/issues/$3" target="_blank" rel="noopener" class="issue-pill">⚑ Issue #$3 — $1/$2 →</a>'
  );
  // Remaining bare URLs → new-tab anchors (lookbehind skips URLs already inside an href;
  // trailing sentence punctuation is kept outside the link).
  h = h.replace(/(?<!["\/=])(https?:\/\/[^\s<>"')\x00]+)/g, (m, url) => {
    const trail = (url.match(/[.,;:!?]+$/) || [''])[0];
    const clean = trail ? url.slice(0, -trail.length) : url;
    return `<a href="${safeUrl(clean)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${clean}</a>${trail}`;
  });

  // Restore the stashed markdown-link anchors.
  h = h.replace(/\x00L(\d+)\x00/g, (_, i) => _stash[+i]);

  // Block pass: headings, lists, tables, blockquotes; remaining prose joins with <br>.
  h = renderMdBlocks(h);
  h = h.replace(/\x00C(\d+)\x00/g, (_, i) => _code[+i]);       // restore fenced code (newlines intact)
  h = h.replace(/\x00T(\d+)\x00/g, (_, i) => _toolCards[+i]);  // restore tool-call cards last
  return h;
}

// Block-level markdown on already-inline-formatted, HTML-escaped text (so `>` is `&gt;`
// and no raw `<`/`>` can inject). A line that isn't a block is prose, joined with <br>.
// Fenced code and tool cards are single-token placeholders (\x00C / \x00T) that pass
// through untouched. Added #dream-chat-markdown — replies used to render flat.
function renderMdBlocks(h) {
  const lines = h.split('\n');
  const out = [];
  const sep = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const splitRow = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const startsBlock = (idx) => {
    const l = lines[idx];
    if (/^#{1,6}\s+/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+\.\s+/.test(l) || /^\s*&gt;\s?/.test(l)) return true;
    if (/^\s*\|.*\|\s*$/.test(l) && idx + 1 < lines.length && sep.test(lines[idx + 1])) return true;   // real table (needs separator row)
    return false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {                       // heading
      out.push(`<h${m[1].length} class="md-h">${m[2].trim()}</h${m[1].length}>`); i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && sep.test(lines[i + 1])) {   // table
      const head = splitRow(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && /^\s*\|.*\|?\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      let t = '<table class="md-table"><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead>';
      if (rows.length) t += '<tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
      out.push(t + '</table>'); continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {                                    // unordered list
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      out.push('<ul class="md-list">' + items.map((x) => `<li>${x}</li>`).join('') + '</ul>'); continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {                                    // ordered list
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      out.push('<ol class="md-list">' + items.map((x) => `<li>${x}</li>`).join('') + '</ol>'); continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {                                     // blockquote (">" escaped to "&gt;")
      const q = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++; }
      out.push('<blockquote class="md-quote">' + q.join('<br>') + '</blockquote>'); continue;
    }
    const prose = [];                                                  // prose → join with <br>
    while (i < lines.length && !startsBlock(i)) { prose.push(lines[i]); i++; }
    out.push(prose.join('<br>'));
  }
  return out.join('\n');
}

// ── Conversation state ────────────────────────────────────────────────────────
let isSending = false;
const history = [];

// #930: a user-facing Stop control. While a stream is in flight we swap the Send
// button for a Stop button that aborts the fetch; on completion/cancel we swap back.
function showStopButton(onStop) {
  const sendBtn = document.getElementById('send-btn');
  let btn = document.getElementById('stop-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'stop-btn';
    btn.type = 'button';
    btn.title = 'Stop generating';
    btn.setAttribute('aria-label', 'Stop generating');
    btn.textContent = '■';
    btn.className = (sendBtn && sendBtn.className ? sendBtn.className + ' ' : '') + 'stop-button';
    if (sendBtn && sendBtn.parentNode) sendBtn.parentNode.insertBefore(btn, sendBtn.nextSibling);
    else document.body.appendChild(btn);
  }
  btn.onclick = () => { try { onStop(); } catch (_e) {} };
  btn.style.display = '';
  if (sendBtn) sendBtn.style.display = 'none';
}
function hideStopButton() {
  const btn = document.getElementById('stop-btn');
  if (btn) btn.style.display = 'none';
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.style.display = '';
}

const FALLBACKS = [
  "No AI providers are set up. Add an API key in Profile → Orchestrator to get started.",
  "All providers offline. Check Profile → Orchestrator to add an API key or start a local model.",
  "Connection quiet. Try again in a moment, or check Profile → Orchestrator for API keys.",
  "No provider answered. Open Profile → Orchestrator to configure Gemini, Claude, or OpenAI.",
  "AI unavailable. Add a provider key in Profile → Orchestrator, or run: ollama serve for local mode.",
];

// ── Quick-start chip helpers ──────────────────────────────────────────────────
function fillPrompt(text) {
  const input = document.getElementById('input');
  input.value = text; input.focus();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
}

function fillAndSend(text) {
  const input = document.getElementById('input');
  input.value = text;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  sendMessage();
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function hideEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.style.display = 'none';
}

// #1926: route/model developer chrome is opt-in. ON when the operator sets
// localStorage `lantern_chat_debug` = "1" (persists), or appends ?debug=1 to the URL
// (one-off, also persists it so a refresh keeps it). OFF for every normal user, so
// the default reply footer is just "Unisona · chat · <time>", no route internals.
function debugChromeOn() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') { localStorage.setItem('lantern_chat_debug', '1'); return true; }
    if (params.get('debug') === '0') { localStorage.removeItem('lantern_chat_debug'); return false; }
    return localStorage.getItem('lantern_chat_debug') === '1';
  } catch { return false; }
}

function addUserBubble(text) {
  hideEmptyState();
  const container = document.getElementById('messages');
  const msg = document.createElement('div');
  msg.className = 'message user';
  msg.innerHTML = `<div class="message-content">${text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function createAgentBubble(isError) {
  const container = document.getElementById('messages');
  const msg = document.createElement('div');
  msg.className = 'message agent' + (isError ? ' error' : '');
  const bubble = document.createElement('div');
  bubble.className = 'message-content';
  const thinking = document.createElement('span');
  thinking.className = 'thinking-mandala';
  // aria-live="polite" so screen readers announce state changes without interrupting.
  // role="status" marks this as a live region for assistive tech.
  thinking.setAttribute('role', 'status');
  thinking.setAttribute('aria-live', 'polite');
  thinking.setAttribute('aria-label', 'Thinking');
  thinking.innerHTML =
    '<img src="/mandala.svg" alt="" class="thinking-spin" style="width:44px;height:44px;opacity:0.85;vertical-align:middle;margin-right:12px">' +
    '<span class="thinking-label" style="font-size:14px;opacity:0.7;vertical-align:middle">Thinking…</span>';
  bubble.appendChild(thinking);
  const cursor = document.createElement('span');
  cursor.className = 'stream-cursor';
  bubble.appendChild(cursor);
  msg.appendChild(bubble);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return { msg, bubble, cursor, thinking };
}


// ── Autowork live-step panel (issue #527 / autonomous-work/stream) ─────────────
// Consumes the SSE stream and renders each phase as it happens, so the user can
// watch plan → patch → tests → commit → push → PR in real time.
// [key, label, description] — the description tells the user what each step is
// actually doing (the panel used to show a bare label + a red ✗ on failure).
const AUTOWORK_PHASES = [
  ['create_issue','File issue',         'filing a tracked GitHub issue for the task'],
  ['fetch_issue', 'Fetch issue',        'reading the issue title + body'],
  ['branch',      'Create branch',      'isolating the work in a fresh git worktree'],
  ['research',    'Research',           'scanning the codebase + web for relevant context'],
  ['plan',        'Generate plan',      'deciding which files to change and how'],
  ['patch',       'Generate patch',     'writing the code diff'],
  ['apply',       'Apply changes',      'applying the diff to the worktree'],
  ['tests',       'Run tests',          'verifying the change against the planned tests'],
  ['commit',      'Commit',             'committing the verified change'],
  ['push',        'Push',               'pushing the branch to GitHub'],
  ['pr',          'Open PR',            'opening a draft pull request'],
  ['convergence', 'Convergence record', 'recording the hypothesis + evidence + confidence'],
  ['record',      'Log record',         'appending the run to the convergence log'],
];

// Every autowork run IS one walk of the North-Star loop (Observe → Remember →
// Reason → Act → Verify → Converge). The strip at the top of the panel makes that
// visible; each step row also carries its stage so the mapping is inspectable.
// `agi-benchmark` is streamed by the server but has no step row — it still lights
// the Converge node, which is why the stage update runs before the row lookup.
const AW_LOOP_STAGES = [
  ['observe',  'Observe'],
  ['remember', 'Remember'],
  ['reason',   'Reason'],
  ['act',      'Act'],
  ['verify',   'Verify'],
  ['converge', 'Converge'],
];
const AW_PHASE_STAGE = {
  create_issue: 'observe', fetch_issue: 'observe',
  research: 'remember',
  plan: 'reason',
  branch: 'act', patch: 'act', apply: 'act', commit: 'act', push: 'act', pr: 'act',
  tests: 'verify',
  convergence: 'converge', record: 'converge', 'agi-benchmark': 'converge',
};

function awLoopStripHtml() {
  return '<div class="aw-loop" role="list" aria-label="Convergence loop progress">'
    + AW_LOOP_STAGES.map(([k, label]) =>
        `<span class="aw-loop-node" role="listitem" data-stage="${k}" title="${label}"><span class="aw-loop-dot"></span><span class="aw-loop-name">${label}</span></span>`
      ).join('<span class="aw-loop-arrow" aria-hidden="true">→</span>')
    + '</div>';
}

function awStepRowsHtml(phases, esc) {
  return phases.map(([k, label, desc]) => {
    const stageKey = AW_PHASE_STAGE[k] || '';
    const stagePair = AW_LOOP_STAGES.find(([s]) => s === stageKey);
    const stageChip = stagePair ? `<span class="aw-stage" data-stage="${stageKey}">${stagePair[1]}</span>` : '';
    return `<div class="aw-step" data-phase="${k}"><div class="aw-ico">○</div><div class="aw-body">`
      + `<div class="aw-row1"><span class="aw-label">${esc(label)}</span>${stageChip}<span class="aw-desc">${esc(desc)}</span><span class="aw-extra"></span></div>`
      + `<div class="aw-detail" style="display:none"></div></div></div>`;
  }).join('');
}

// Recompute every node from the step rows. Order-independent on purpose: the
// pipeline is NOT in loop order (branch — an Act phase — runs before research),
// so "mark all earlier stages done" forward-marking lit Reason before the plan
// step ever ran. Truth lives in the rows: a stage is active if any of its phases
// is active/retrying, error if one errored, done once at least one finished.
function awUpdateLoop(row, phase, status) {
  if (!row) return;
  const state = {};
  const fold = (stageKey, cls) => {
    if (!stageKey) return;
    const st = state[stageKey] || (state[stageKey] = { active: false, error: false, done: false });
    if (cls === 'active' || cls === 'retry') st.active = true;
    else if (cls === 'error') st.error = true;
    // 'skipped' deliberately does NOT count as done: a skipped Verify stage lit the
    // strip green on a zero-tests run. Skipped stages stay unlit — honest.
    else if (cls === 'done') st.done = true;
  };
  row.querySelectorAll('.aw-step').forEach((el) => {
    const cls = el.classList.contains('is-active') ? 'active'
      : el.classList.contains('is-retry') ? 'retry'
      : el.classList.contains('is-error') ? 'error'
      : el.classList.contains('is-done') ? 'done'
      : ((el.querySelector('.aw-ico') || {}).textContent === '⊘') ? 'skipped' : null;
    fold(AW_PHASE_STAGE[el.dataset.phase], cls);
  });
  // The triggering event isn't in its row yet (setStep updates the row after this),
  // and some phases have no row at all (agi-benchmark) — fold it in directly.
  fold(AW_PHASE_STAGE[phase], status === 'start' ? 'active' : status);
  row.querySelectorAll('.aw-loop-node').forEach((node) => {
    const st = state[node.dataset.stage] || { active: false, error: false, done: false };
    node.classList.toggle('is-active', st.active);
    node.classList.toggle('is-error', st.error && !st.active);
    node.classList.toggle('is-done', st.done && !st.active && !st.error);
  });
}

// On success light the whole loop; on failure freeze it where it stopped so the
// strip itself answers "how far did the run get" — a stage still marked active at
// the stop is where it died, so it flips to the error state rather than pulsing on.
function awFinishLoop(row, ok) {
  if (!row) return;
  row.querySelectorAll('.aw-loop-node').forEach((node) => {
    if (ok) { node.classList.remove('is-active', 'is-error'); node.classList.add('is-done'); }
    else if (node.classList.contains('is-active')) { node.classList.remove('is-active'); node.classList.add('is-error'); }
  });
}

// Inject the autowork panel styles once: compact rows (white-space:normal kills the
// chat bubble's pre-wrap that was blowing each step up to ~130px tall), the mandala
// spinner for the active step, and a responsive layout that drops descriptions on
// narrow screens.
function ensureAutoworkStyles() {
  if (document.getElementById('aw-styles')) return;
  const st = document.createElement('style');
  st.id = 'aw-styles';
  st.textContent = [
    '.aw-panel{white-space:normal;font-size:13px}',
    '.aw-activity{display:flex;align-items:center;gap:9px;padding:8px 10px;margin-bottom:8px;border:1px solid var(--border,#222);border-radius:10px;background:var(--surface2,rgba(127,127,127,.06))}',
    '.aw-activity img{width:22px;height:22px;flex:none}',
    '.aw-act-text{font-size:12.5px;line-height:1.35;min-width:0}',
    '.aw-act-text b{font-weight:700}.aw-act-text span{opacity:.65}',
    '.aw-spin{animation:aw-spin 2.4s linear infinite}',
    '@keyframes aw-spin{to{transform:rotate(360deg)}}',
    '.aw-steps{white-space:normal;display:flex;flex-direction:column;gap:1px}',
    '.aw-step{display:flex;align-items:flex-start;gap:8px;padding:3px 4px;border-radius:6px;opacity:.45;transition:opacity .15s,background .15s}',
    '.aw-step.is-active{opacity:1;background:var(--surface2,rgba(92,200,255,.08))}',
    '.aw-step.is-done,.aw-step.is-error,.aw-step.is-retry{opacity:1}',
    '.aw-ico{width:18px;height:18px;flex:none;display:flex;align-items:center;justify-content:center;font-size:13px;line-height:1}',
    '.aw-ico img{width:16px;height:16px}',
    '.aw-body{flex:1;min-width:0}',
    '.aw-row1{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
    '.aw-label{font-size:12.5px;font-weight:600}',
    '.aw-desc{font-size:11.5px;opacity:.6}',
    '.aw-extra{font-size:11px;opacity:.7;margin-left:auto;white-space:nowrap}',
    '.aw-detail{font-size:11.5px;opacity:.85;line-height:1.4;margin-top:2px}',
    '@media (max-width:520px){.aw-desc{display:none}.aw-extra{margin-left:0}}',
    '.aw-loop{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:8px;padding:6px 9px;border:1px solid var(--border,#222);border-radius:10px;background:var(--surface2,rgba(127,127,127,.05))}',
    '.aw-loop-node{display:inline-flex;align-items:center;gap:4px;opacity:.4;transition:opacity .2s}',
    '.aw-loop-node.is-active,.aw-loop-node.is-error{opacity:1}',
    '.aw-loop-node.is-done{opacity:.85}',
    '.aw-loop-dot{width:8px;height:8px;border-radius:50%;background:var(--border,#555);flex:none;transition:background .2s}',
    '.aw-loop-node.is-active .aw-loop-dot{background:var(--accent,#06b6d4);animation:aw-pulse 1.6s ease-in-out infinite}',
    '.aw-loop-node.is-done .aw-loop-dot{background:#4ade80}',
    '.aw-loop-node.is-error .aw-loop-dot{background:#f87171}',
    '.aw-loop-name{font-size:10.5px;font-weight:600;letter-spacing:.02em}',
    '.aw-loop-arrow{opacity:.3;font-size:10px}',
    '@keyframes aw-pulse{50%{opacity:.55}}',
    '.aw-stage{font-size:9.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.5;border:1px solid var(--border,#333);border-radius:5px;padding:0 4px;flex:none}',
    '.aw-conv{margin-top:8px;font-weight:400}',
    '.aw-conv-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}',
    '.aw-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:7px;border:1px solid var(--border,#333)}',
    '.aw-chip-ok{border-color:rgba(74,222,128,.45);color:#4ade80}',
    '.aw-chip-warn{border-color:rgba(250,204,21,.5);color:#facc15}',
    '.aw-chip-info{border-color:rgba(96,165,250,.45);color:#60a5fa}',
    '.aw-conf-bar{display:inline-block;width:52px;height:6px;border-radius:4px;background:var(--surface2,rgba(127,127,127,.18));overflow:hidden;vertical-align:middle}',
    '.aw-conf-bar>span{display:block;height:100%;border-radius:4px;background:var(--accent,#06b6d4)}',
    '.aw-conv-ev{margin-top:6px;font-size:11.5px;font-weight:400}',
    '.aw-conv-ev summary{cursor:pointer;opacity:.75}',
    '.aw-conv-ev ul{margin:6px 0 0 16px;padding:0;opacity:.85;line-height:1.5}',
    '@media (max-width:520px){.aw-loop-name{display:none}.aw-loop-node.is-active .aw-loop-name{display:inline}.aw-stage{display:none}}',
  ].join('\n');
  document.head.appendChild(st);
}

// The Verify + Converge stages rendered where the decision happens: council
// verdict, tests outcome, and the convergence record's confidence, attached to
// the finale the Approve button lives in. The server streams all of this on the
// `done` event (and persists it in the run log's result record for reconnects) —
// until now the client discarded it and showed only "View PR".
function renderConvergenceSummary(fin, d) {
  if (!fin || !d) return;
  if (fin.querySelector('.aw-conv')) return;   // don't double-render on reconnect
  const conv = d.convergence || null;
  const verdict = d.councilVerdict || null;
  const conf = conv && conv.confidence ? conv.confidence : null;
  const testsPassed = (typeof d.testsPassed === 'boolean') ? d.testsPassed
    : (conf && typeof conf.testsPassed === 'number') ? (conf.testsPassed >= 0.5 ? true : (conf.testsPassed > 0 ? false : null))
    : null;
  if (!conv && !verdict && testsPassed == null) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const chips = [];
  if (verdict) {
    const cls = verdict === 'grounded' ? 'ok' : verdict === 'seam_open' ? 'warn' : 'info';
    const delta = (d.councilDelta != null) ? ` (Δ=${esc(d.councilDelta)})` : '';
    chips.push(`<span class="aw-chip aw-chip-${cls}" title="Σ₀ council answerability verdict${delta}">${verdict === 'seam_open' ? '⚠ ' : ''}council: ${esc(verdict)}</span>`);
  }
  if (testsPassed != null) chips.push(`<span class="aw-chip aw-chip-${testsPassed ? 'ok' : 'warn'}">tests: ${testsPassed ? 'passed' : 'failed'}</span>`);
  else if (conf && conf.testsPassed === 0) chips.push('<span class="aw-chip aw-chip-warn">tests: not run</span>');
  if (conf && typeof conf.overall === 'number') {
    const pct = Math.max(0, Math.min(100, Math.round(conf.overall * 100)));
    const fmt = v => (typeof v === 'number' ? v.toFixed(2) : '–');
    // #2803: don't let the meter perform calibration the record doesn't have — when the
    // server declares the basis, say which terms are formula priors vs measured.
    const basisNote = (conv && conv.confidenceBasis)
      ? ' · basis: formula priors (measured: calibratedTrust only)' : '';
    chips.push(`<span class="aw-chip" title="research ${fmt(conf.research)} · grounded ${fmt(conf.grounded)} · tests ${fmt(conf.testsPassed)}${basisNote}">confidence <span class="aw-conf-bar"><span style="width:${pct}%"></span></span> ${pct}%</span>`);
  }
  const card = document.createElement('div');
  card.className = 'aw-conv';
  card.innerHTML = `<div class="aw-conv-chips">${chips.join('')}</div>`
    + (conv && Array.isArray(conv.evidence) && conv.evidence.length
        ? `<details class="aw-conv-ev"><summary>convergence record — ${esc(conv.hypothesis || 'evidence')}</summary><ul>${conv.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>`
        : '');
  fin.appendChild(card);
}

// Why the Approve button should warn, or null when the run is clean. seam_open
// (contested + no passing execution check) and failed/skipped tests are the two
// states where a one-click merge silently launders unverified work.
function awApproveWarnReason(d) {
  if (!d) return null;
  if (d.councilVerdict === 'seam_open') return 'Σ₀ council: seam_open — contested, no passing execution check';
  if (d.testsPassed === false) return 'tests failed on this change';
  const cf = d.convergence && d.convergence.confidence;
  if (d.testsPassed == null && cf && typeof cf.testsPassed === 'number' && cf.testsPassed <= 0) return 'tests were not run on this change';
  return null;
}

// In-chat review actions for an autowork draft PR (#1503): Approve (mark ready +
// squash-merge), Rework (re-run autowork on the same issue), Discard (close + delete
// branch). Approve/Discard hit POST /api/convergence/pr-action behind a confirm;
// Rework just re-invokes runAutowork. No-op when there's no PR to act on.
// `opts.warn` + `opts.warnReason` flip Approve into an explicit "Approve anyway"
// with the unverified-state reason in the button, the tooltip, and the confirm.
function renderAutoworkActions(fin, prUrl, issue, btn, base, opts) {
  if (!fin || !prUrl) return;
  if (fin.querySelector('.aw-actions')) return;   // don't double-render on reconnect
  const bar = document.createElement('div');
  bar.className = 'aw-actions';
  bar.style.cssText = 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center';
  const mk = (label, title, color) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = title;
    b.style.cssText = `font:600 11px var(--font-sans,sans-serif);padding:4px 10px;border-radius:8px;border:1px solid ${color};background:transparent;color:${color};cursor:pointer`;
    return b;
  };
  const warn = !!(opts && opts.warn);
  const warnWhy = (opts && opts.warnReason) || 'verification incomplete';
  const approve = warn
    ? mk('⚠ Approve anyway', 'Verification incomplete — ' + warnWhy + '. Merging skips the evidence gate.', '#facc15')
    : mk('✓ Approve', 'Mark ready for review & squash-merge', '#4ade80');
  const rework  = mk('↻ Rework',  'Re-run autowork on this issue (supersedes this attempt)', '#a78bfa');
  const discard = mk('✕ Discard', 'Close the PR & delete its branch', '#f87171');
  const all = [approve, rework, discard];
  const setMsg = (txt, color) => {
    let m = bar.querySelector('.aw-action-msg');
    if (!m) { m = document.createElement('span'); m.className = 'aw-action-msg'; m.style.cssText = 'font-size:11px;margin-left:4px'; bar.appendChild(m); }
    m.style.color = color || ''; m.textContent = txt;
  };
  async function doAction(action, confirmText) {
    if (!window.confirm(confirmText)) return;
    all.forEach(b => b.disabled = true);
    setMsg('Working…', '');
    try {
      const r = await (await fetch(`${base}/api/convergence/pr-action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prUrl, action }),
      })).json();
      if (r && r.ok) { setMsg('✓ ' + (r.message || 'Done'), '#4ade80'); approve.remove(); discard.remove(); rework.remove(); }
      else { setMsg('✗ ' + ((r && r.error) || 'Failed'), '#f87171'); all.forEach(b => b.disabled = false); }
    } catch (e) { setMsg('✗ ' + (e && e.message || 'request failed'), '#f87171'); all.forEach(b => b.disabled = false); }
  }
  approve.onclick = () => doAction('approve', (warn ? `⚠ ${warnWhy}.\n\n` : '') + `Approve and squash-merge this PR?\n\n${prUrl}`);
  discard.onclick = () => doAction('discard', `Discard (close) this PR and delete its branch?\n\n${prUrl}`);
  rework.onclick = () => {
    if (!window.confirm(`Re-run autowork on issue #${issue}? This supersedes the current attempt.`)) return;
    if (typeof runAutowork === 'function' && btn) runAutowork(parseInt(issue, 10) || issue, btn, base).catch(e => console.error('[autowork rework]', e));
  };
  all.forEach(b => bar.appendChild(b));
  fin.appendChild(bar);
}

// In-chat accept/reject for a pull request being REVIEWED (#1503 follow-up). The
// `!review #N` / `!prs` flow renders a diff + verdict but, until now, offered no way
// to act on it — so "review a PR in chat, then accept it in chat" dead-ended at
// GitHub. This attaches the same Approve / Discard actions the autowork run panel
// gives a fresh draft PR (POST /api/convergence/pr-action), keyed by PR number, to
// ANY reviewed PR — closing the work → review → accept loop in one surface. No Rework
// button here: a bare PR review isn't tied to a known issue/run to re-drive.
function renderPrReviewActions(container, prNum, base) {
  if (!container || !prNum) return;
  if (container.querySelector('.pr-review-actions')) return;   // don't double-render on re-render
  base = base || ((typeof serverBase !== 'undefined') ? serverBase : window.location.origin);
  const prUrl = `https://github.com/alex-place/lantern-os/pull/${prNum}`;
  const bar = document.createElement('div');
  bar.className = 'pr-review-actions';
  bar.style.cssText = 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center';
  const mk = (label, title, color) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = title;
    b.style.cssText = `font:600 11px var(--font-sans,sans-serif);padding:4px 10px;border-radius:8px;border:1px solid ${color};background:transparent;color:${color};cursor:pointer`;
    return b;
  };
  const approve = mk('✓ Approve & merge', 'Mark ready for review & squash-merge', '#4ade80');
  const discard = mk('✕ Discard', 'Close the PR & delete its branch', '#f87171');
  const all = [approve, discard];
  const setMsg = (txt, color) => {
    let m = bar.querySelector('.pr-action-msg');
    if (!m) { m = document.createElement('span'); m.className = 'pr-action-msg'; m.style.cssText = 'font-size:11px;margin-left:4px'; bar.appendChild(m); }
    m.style.color = color || ''; m.textContent = txt;
  };
  async function doAction(action, confirmText) {
    if (!window.confirm(confirmText)) return;
    all.forEach(b => b.disabled = true);
    setMsg('Working…', '');
    try {
      const r = await (await fetch(`${base}/api/convergence/pr-action`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr: prNum, action }),
      })).json();
      if (r && r.ok) { setMsg('✓ ' + (r.message || 'Done'), '#4ade80'); approve.remove(); discard.remove(); }
      else { setMsg('✗ ' + ((r && r.error) || 'Failed'), '#f87171'); all.forEach(b => b.disabled = false); }
    } catch (e) { setMsg('✗ ' + (e && e.message || 'request failed'), '#f87171'); all.forEach(b => b.disabled = false); }
  }
  approve.onclick = () => doAction('approve', `Approve and squash-merge PR #${prNum}?\n\n${prUrl}`);
  discard.onclick = () => doAction('discard', `Discard (close) PR #${prNum} and delete its branch?\n\n${prUrl}`);
  all.forEach(b => bar.appendChild(b));
  container.appendChild(bar);
}

// Convergence-agent action chips — the server may attach {label, href|command}
// follow-up suggestions to a done event (see convergence-agent.js). Render them as a
// chip row. NOTE: this was called at finalize but never defined, which threw a
// ReferenceError mid-finalize and skipped the assistant history.push — the memory-loss
// bug. Kept side-effect-free and no client-side keyword routing (a command chip only
// drops its text into the composer for the user to review + send).
function renderActionChips(bubble, actions, base) {
  if (!bubble || !Array.isArray(actions) || !actions.length) return;
  if (bubble.querySelector('.action-chips')) return;   // don't double-render
  base = base || ((typeof serverBase !== 'undefined') ? serverBase : window.location.origin);
  const bar = document.createElement('div');
  bar.className = 'action-chips';
  bar.style.cssText = 'margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center';
  const CHIP = 'font:600 11px var(--font-sans,sans-serif);padding:4px 10px;border-radius:8px;border:1px solid var(--accent,#06b6d4);background:transparent;color:var(--accent,#06b6d4);cursor:pointer;text-decoration:none';
  actions.forEach((a) => {
    if (!a || !a.label) return;
    if (a.href) {
      const link = document.createElement('a');
      link.className = 'action-chip';
      link.textContent = a.label;
      link.href = (typeof safeUrl === 'function') ? safeUrl(a.href) : a.href;
      if (/^https?:\/\//i.test(a.href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      link.style.cssText = CHIP;
      bar.appendChild(link);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-chip';
      btn.textContent = a.label;
      btn.style.cssText = CHIP;
      btn.addEventListener('click', () => {
        const input = document.getElementById('input');
        if (input) { input.value = a.command || a.label; input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      bar.appendChild(btn);
    }
  });
  if (bar.children.length) bubble.appendChild(bar);
}

// `target` is either an issue number (number/numeric string — `!work #N`) or a
// free-form task object `{ task: "fix the intent handler" }` from the chat
// "Run as autowork" button. Task mode files a GitHub issue first (server-side),
// then runs the identical issue-linked pipeline → linked draft PR.
async function runAutowork(target, btn, base) {
  base = base || ((typeof serverBase !== 'undefined') ? serverBase : window.location.origin);
  hideEmptyState();
  const messages = document.getElementById('messages');

  const taskMode = target && typeof target === 'object' && typeof target.task === 'string';
  const issue = taskMode ? null : target;
  const reqBody = taskMode
    ? { task: target.task, commit: true, push: true }
    : { issue, commit: true, push: true };
  const panelLabel = taskMode ? 'task' : ('#' + String(issue == null ? '' : issue));

  // Build the panel
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  ensureAutoworkStyles();
  // The "File issue" step only applies to task mode; drop it for issue-number runs.
  const phases = taskMode ? AUTOWORK_PHASES : AUTOWORK_PHASES.filter(([k]) => k !== 'create_issue');
  const PHASE_INFO = Object.fromEntries(AUTOWORK_PHASES.map((p) => [p[0], { label: p[1], desc: p[2] }]));
  const stepRowsHtml = awStepRowsHtml(phases, esc);
  // Activity line = a live, streamed-feel header: the mandala spins while a step runs
  // and the text names what's happening right now (addresses "shows little/no info").
  row.innerHTML =
    `<div class="msg-label">Unisona · Autowork ${esc(panelLabel)}</div>`
    + `<div class="bubble aw-panel">`
    + `<div class="aw-activity"><img src="/mandala.svg" class="aw-spin" alt=""><div class="aw-act-text"><b>Starting autowork…</b> <span>${esc(taskMode ? 'filing the task as an issue' : 'on issue ' + panelLabel)}</span></div></div>`
    + awLoopStripHtml()
    + `<div class="aw-steps">${stepRowsHtml}</div>`
    + `<div class="aw-diff" style="display:none;margin-top:8px"></div>`
    + `<div class="aw-final" style="margin-top:8px;font-weight:600"></div>`
    + `</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();

  const actImg = row.querySelector('.aw-activity img');
  const actText = row.querySelector('.aw-act-text');
  const setActivity = (label, desc, spinning) => {
    if (actText) actText.innerHTML = '<b>' + esc(label) + '</b>' + (desc ? ' <span>— ' + esc(desc) + '</span>' : '');
    if (actImg) actImg.classList.toggle('aw-spin', spinning !== false);
  };

  const setStep = (phase, status, extra, detail) => {
    awUpdateLoop(row, phase, status);   // before the row lookup — agi-benchmark has no row but lights Converge
    const el = row.querySelector(`.aw-step[data-phase="${phase}"]`);
    if (!el) return;
    el.classList.remove('is-active', 'is-done', 'is-error', 'is-retry');
    const ico = el.querySelector('.aw-ico');
    ico.style.color = '';
    if (status === 'start')        { el.classList.add('is-active'); ico.innerHTML = '<img src="/mandala.svg" class="aw-spin" alt="">'; }
    else if (status === 'done')    { el.classList.add('is-done');  ico.textContent = '✓'; ico.style.color = '#4ade80'; }
    else if (status === 'error')   { el.classList.add('is-error'); ico.textContent = '✗'; ico.style.color = '#f87171'; }
    else if (status === 'retry')   { el.classList.add('is-retry'); ico.textContent = '↻'; ico.style.color = '#facc15'; }
    else if (status === 'skipped') { ico.textContent = '⊘'; ico.style.color = '#facc15'; el.style.opacity = '1'; }
    if (extra) el.querySelector('.aw-extra').textContent = extra;
    // Surface WHY a step retried/failed, in plain language, right under the row —
    // so a failure is never an unexplained red ✗ (the transparency fix).
    if (detail) {
      const det = el.querySelector('.aw-detail');
      det.textContent = detail;
      det.style.display = 'block';
      det.style.color = (status === 'error') ? '#f87171' : (status === 'retry') ? '#facc15' : '';
    }
  };

  try {
    const resp = await fetch(`${base}/api/convergence/autonomous-work/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    if (!resp.ok || !resp.body) throw new Error(`stream_unavailable_${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalDone = null;
    let awRunId = null;   // captured from the 'run' event → lets us re-attach if the SSE drops

    const handleEvent = (evName, data) => {
      let d = {};
      try { d = JSON.parse(data); } catch { return; }
      if (evName === 'run') { awRunId = d.runId; AW_LOCAL_RUNS.add(d.runId); return; }
      if (evName === 'step') {
        let extra = '';
        if (d.phase === 'tests' && d.status === 'done') extra = d.ran ? (d.passed ? 'passed' : 'failed') : 'none';
        else if (d.phase === 'research' && d.status === 'done') extra = `${d.filesFound || 0} files · ${d.webSourcesFound || 0} web`;
        else if (d.phase === 'create_issue' && d.status === 'done') extra = `#${d.issue}`;
        else if (d.phase === 'pr' && d.status === 'done') extra = 'PR opened';
        else if (d.status === 'retry') extra = `retry ${d.attempt || ''}`.trim();
        setStep(d.phase, d.status, extra, d.detail);
        // Keep the live activity header in sync with the current step.
        const info = PHASE_INFO[d.phase] || { label: d.phase, desc: '' };
        if (d.status === 'start')      setActivity(info.label + '…', info.desc, true);
        else if (d.status === 'retry') setActivity(info.label + ' — retrying', d.detail || '', true);
        else if (d.status === 'error') setActivity(info.label + ' failed', d.detail || '', false);
      } else if (evName === 'diff') {
        const diffEl = row.querySelector('.aw-diff');
        const files = (d.files || []).join(', ');
        diffEl.style.display = 'block';
        diffEl.innerHTML =
          `<details><summary style="cursor:pointer;opacity:0.8">📄 Diff — ${esc(files) || 'changes'}</summary>
             <pre style="white-space:pre-wrap;max-height:240px;overflow:auto;background:var(--bg,#0a0a0a);border:1px solid var(--border,#222);border-radius:6px;padding:8px;font-size:11px;margin-top:6px">${esc(d.diffText || '')}</pre>
           </details>`;
      } else if (evName === 'error') {
        const fin = row.querySelector('.aw-final');
        fin.style.color = '#f87171';
        // Grounded failure (#1348): show the cause, with the raw provider/stage detail
        // tucked into an expandable line so it's actionable but not noisy.
        fin.innerHTML = `✗ ${esc(d.error || 'error')}`
          + (d.detail ? `<details style="margin-top:4px"><summary style="cursor:pointer;opacity:.7;font-size:11px">detail</summary><pre style="white-space:pre-wrap;font-size:11px;opacity:.8;margin:4px 0">${esc(d.detail)}</pre></details>` : '');
      } else if (evName === 'done') {
        finalDone = d;
      }
      if (typeof scrollToBottom === 'function') scrollToBottom();
    };

    // SSE parse loop
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop();
      for (const chunk of chunks) {
        const evMatch = chunk.match(/^event:\s*(.+)$/m);
        const dataMatch = chunk.match(/^data:\s*([\s\S]+)$/m);
        if (evMatch && dataMatch) handleEvent(evMatch[1].trim(), dataMatch[1].trim());
      }
    }

    // Render final state
    const fin = row.querySelector('.aw-final');
    if (finalDone && finalDone.ok) {
      if (btn) { btn.textContent = '✓ Done'; btn.style.color = '#4ade80'; }
      fin.style.color = '#4ade80';
      fin.innerHTML = finalDone.prUrl
        ? `✓ Auto-worked #${esc(finalDone.issue || issue)} — <a href="${esc(finalDone.prUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">View PR</a>`
        : `✓ ${esc(finalDone.message || 'Done')}`;
      awFinishLoop(row, true);
      renderConvergenceSummary(fin, finalDone);
      const liveWarn = awApproveWarnReason(finalDone);
      renderAutoworkActions(fin, finalDone.prUrl, finalDone.issue || issue, btn, base,
        liveWarn ? { warn: true, warnReason: liveWarn } : undefined);
      setActivity('Complete', finalDone.prUrl ? 'opened a pull request' : 'autonomous work finished', false);
      if (actImg) actImg.src = '/mandala.svg'; // steady (no spin)
    } else {
      if (btn) { btn.textContent = '✗ Failed'; btn.style.color = '#f87171'; }
      awFinishLoop(row, false);
      if (!fin.textContent) {
        fin.style.color = '#f87171';
        fin.textContent = `✗ ${esc((finalDone && finalDone.message) || 'Auto-work failed')}`;
      }
      setActivity('Stopped', (finalDone && finalDone.message) || 'see the failed step above', false);
    }
    if (typeof scrollToBottom === 'function') scrollToBottom();
  } catch (e) {
    if (btn) { btn.textContent = '✗ Error'; btn.style.color = '#f87171'; }
    // The SSE connection dropped mid-run (long plan/patch steps can outlast an idle
    // proxy). Flip the still-spinning active step to an error glyph and stop the
    // mandala — otherwise the panel spins forever with no explanation.
    const activeStep = row.querySelector('.aw-step.is-active');
    if (activeStep) {
      activeStep.classList.remove('is-active');
      activeStep.classList.add('is-error');
      const ai = activeStep.querySelector('.aw-ico');
      if (ai) { ai.textContent = '✗'; ai.style.color = '#f87171'; }
    }
    // 401/403 from the stream endpoint = not an outage, an auth gate: autowork
    // mutates the repo, so the server (correctly) refuses guest sessions. Say that,
    // with the door to fix it — "Connection lost — stream_unavailable_403" told the
    // user nothing actionable.
    const mAuth = String(e && e.message || '').match(/stream_unavailable_(401|403)/);
    if (mAuth) {
      setActivity('Autowork needs an operator sign-in', 'this session is a guest — autowork changes the repo, so it requires an operator account', false);
      const finAuth = row.querySelector('.aw-final');
      finAuth.style.color = '#f87171';
      finAuth.innerHTML = `✗ Autowork requires an operator session (HTTP ${esc(mAuth[1])}). <a href="/auth.html?returnTo=%2Fchat.html" style="color:var(--accent)">Sign in</a> and re-run \`!work #${esc(String(issue == null ? '' : issue))}\`.`;
      if (typeof scrollToBottom === 'function') scrollToBottom();
      return;
    }
    const isNet = /network|failed to fetch|load failed/i.test(e && e.message || '');
    const fin = row.querySelector('.aw-final');
    // Recovery: the run keeps executing server-side after a disconnect. If we captured
    // a runId, poll the status endpoint — the chat re-attaches to the finished run
    // (incl. the PR url) instead of giving up on a "network error".
    if (isNet && awRunId) {
      setActivity('Reconnecting…', 'connection dropped — the run is still going on the server; waiting for it to finish', true);
      fin.style.color = '';
      fin.textContent = '';
      let recovered = false;
      for (let i = 0; i < 48; i++) {   // ~4 min at 5s
        await new Promise(r => setTimeout(r, 5000));
        let s = null;
        try { s = await (await fetch(`${base}/api/convergence/autonomous-work/status?runId=${encodeURIComponent(awRunId)}`)).json(); } catch (_e) { continue; }
        if (s && s.found && s.latestPhase) setActivity('Reconnecting…', `server is at: ${s.latestPhase} (${s.latestStatus || ''})`, true);
        if (s && s.done) {
          recovered = true;
          if (s.succeeded && s.prUrl) {
            setActivity('Complete', 'recovered after a dropped connection', false);
            fin.style.color = '#4ade80';
            fin.innerHTML = `✓ Auto-worked #${esc(s.message && s.message.match(/#(\d+)/) ? RegExp.$1 : (issue || ''))} — <a href="${esc(s.prUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">View PR</a> <span style="opacity:.6;font-size:11px">(reconnected)</span>`;
            awFinishLoop(row, true);
            renderConvergenceSummary(fin, s);
            const reWarn = awApproveWarnReason(s);
            renderAutoworkActions(fin, s.prUrl, (s.message && s.message.match(/#(\d+)/) ? RegExp.$1 : issue), btn, base,
              reWarn ? { warn: true, warnReason: reWarn } : undefined);
          } else {
            setActivity('Stopped', s.message || 'run ended', false);
            fin.style.color = '#f87171';
            fin.textContent = `✗ ${esc(s.message || ('run ended at ' + (s.latestPhase || 'an unknown step')))}`;
          }
          break;
        }
      }
      if (!recovered) {
        setActivity('Connection lost', 'could not confirm the result — check the issue on GitHub for a new PR', false);
        fin.style.color = '#f87171';
        fin.textContent = '✗ Lost connection mid-run and timed out waiting to reconnect. The run may still finish on the server — check the issue for a new PR.';
      }
      if (typeof scrollToBottom === 'function') scrollToBottom();
      return;
    }
    const msg = isNet ? 'Lost connection to the server mid-run (the run may still be finishing on the server — check the issue for a new PR).' : (e && e.message) || 'unknown error';
    setActivity('Connection lost', msg, false);
    fin.style.color = '#f87171';
    fin.textContent = `✗ ${msg}`;
    if (typeof scrollToBottom === 'function') scrollToBottom();
  }
}

// ── Background autowork watcher ────────────────────────────────────────────────
// Autowork is never headless-invisible: runs started OUTSIDE this chat client (the
// auto-dispatch daemon, CI/fleet POSTs, another tab) are discovered via
// /api/convergence/autonomous-work/active and get the same live step panel in-chat,
// driven by polling /autonomous-work/status (which carries the full step history).
const AW_LOCAL_RUNS = new Set();     // runIds this client started (already have a panel)
const AW_WATCHED_RUNS = new Set();   // background runIds already given a panel

function attachBackgroundAutoworkPanel(run, base) {
  hideEmptyState();
  const messages = document.getElementById('messages');
  if (!messages) return;
  ensureAutoworkStyles();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const srcLabel = run.source === 'auto-dispatch' ? 'Auto-dispatch' : (run.source || 'background');
  const issue = run.issue;
  const phases = AUTOWORK_PHASES.filter(([k]) => k !== 'create_issue');
  const PHASE_INFO = Object.fromEntries(AUTOWORK_PHASES.map((p) => [p[0], { label: p[1], desc: p[2] }]));
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML =
    `<div class="msg-label">Unisona · ${esc(srcLabel)} · Autowork #${esc(issue)}</div>`
    + `<div class="bubble aw-panel">`
    + `<div class="aw-activity"><img src="/mandala.svg" class="aw-spin" alt=""><div class="aw-act-text"><b>Background autowork on #${esc(issue)}</b> <span>${esc(run.title || 'started by ' + srcLabel.toLowerCase() + ' — attaching live')}</span></div></div>`
    + awLoopStripHtml()
    + `<div class="aw-steps">${awStepRowsHtml(phases, esc)}</div>`
    + `<div class="aw-final" style="margin-top:8px;font-weight:600"></div>`
    + `</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();

  const actImg = row.querySelector('.aw-activity img');
  const actText = row.querySelector('.aw-act-text');
  const setActivity = (label, desc, spinning) => {
    if (actText) actText.innerHTML = '<b>' + esc(label) + '</b>' + (desc ? ' <span>— ' + esc(desc) + '</span>' : '');
    if (actImg) actImg.classList.toggle('aw-spin', spinning !== false);
  };
  const setStep = (phase, status, extra, detail) => {
    awUpdateLoop(row, phase, status);   // before the row lookup — agi-benchmark has no row but lights Converge
    const el = row.querySelector(`.aw-step[data-phase="${phase}"]`);
    if (!el) return;
    el.classList.remove('is-active', 'is-done', 'is-error', 'is-retry');
    const ico = el.querySelector('.aw-ico');
    ico.style.color = '';
    if (status === 'start')        { el.classList.add('is-active'); ico.innerHTML = '<img src="/mandala.svg" class="aw-spin" alt="">'; }
    else if (status === 'done')    { el.classList.add('is-done');  ico.textContent = '✓'; ico.style.color = '#4ade80'; }
    else if (status === 'error')   { el.classList.add('is-error'); ico.textContent = '✗'; ico.style.color = '#f87171'; }
    else if (status === 'retry')   { el.classList.add('is-retry'); ico.textContent = '↻'; ico.style.color = '#facc15'; }
    else if (status === 'skipped') { ico.textContent = '⊘'; ico.style.color = '#facc15'; el.style.opacity = '1'; }
    if (extra) el.querySelector('.aw-extra').textContent = extra;
    if (detail) {
      const det = el.querySelector('.aw-detail');
      det.textContent = detail;
      det.style.display = 'block';
      det.style.color = (status === 'error') ? '#f87171' : (status === 'retry') ? '#facc15' : '';
    }
  };
  const applySteps = (steps) => {
    for (const s of steps || []) {
      let extra = '';
      if (s.phase === 'tests' && s.status === 'done') extra = s.ran ? (s.passed ? 'passed' : 'failed') : 'none';
      else if (s.phase === 'research' && s.status === 'done') extra = `${s.filesFound || 0} files · ${s.webSourcesFound || 0} web`;
      else if (s.phase === 'pr' && s.status === 'done') extra = 'PR opened';
      else if (s.status === 'retry') extra = `retry ${s.attempt || ''}`.trim();
      setStep(s.phase, s.status, extra, s.detail || s.error);
      const info = PHASE_INFO[s.phase];
      if (info && s.status === 'start') setActivity(info.label + '…', info.desc, true);
    }
  };

  (async () => {
    const fin = row.querySelector('.aw-final');
    for (let i = 0; i < 480; i++) {   // up to ~40 min at 5s — matches the daemon ceiling
      let s = null;
      try { s = await (await fetch(`${base}/api/convergence/autonomous-work/status?runId=${encodeURIComponent(run.runId)}`)).json(); } catch (_e) { /* transient */ }
      if (s && s.found) {
        applySteps(s.steps);
        if (s.done) {
          if (s.succeeded && s.prUrl) {
            setActivity('Complete', 'background run opened a pull request', false);
            fin.style.color = '#4ade80';
            fin.innerHTML = `✓ Auto-worked #${esc(issue)} — <a href="${esc(s.prUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">View PR</a>`;
            awFinishLoop(row, true);
            renderConvergenceSummary(fin, s);
            const bgWarn = awApproveWarnReason(s);
            renderAutoworkActions(fin, s.prUrl, issue, row.querySelector('.aw-ico'), base,
              bgWarn ? { warn: true, warnReason: bgWarn } : undefined);
          } else {
            setActivity('Stopped', s.message || 'run ended', false);
            fin.style.color = '#f87171';
            fin.textContent = `✗ ${(s.message || ('run ended at ' + (s.latestPhase || 'an unknown step')))}`;
          }
          if (typeof scrollToBottom === 'function') scrollToBottom();
          return;
        }
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    setActivity('Detached', 'stopped watching after 40 minutes — check GitHub for the PR', false);
  })();
}

function startBackgroundAutoworkWatcher() {
  const base = (typeof serverBase !== 'undefined') ? serverBase : window.location.origin;
  const poll = async () => {
    if (document.hidden) return;
    if (!document.getElementById('messages')) return;
    let d = null;
    try { d = await (await fetch(`${base}/api/convergence/autonomous-work/active`)).json(); } catch (_e) { return; }
    for (const run of (d && d.active) || []) {
      if (!run.runId || run.source === 'chat') continue;              // chat runs already have a live panel
      if (AW_LOCAL_RUNS.has(run.runId) || AW_WATCHED_RUNS.has(run.runId)) continue;
      AW_WATCHED_RUNS.add(run.runId);
      attachBackgroundAutoworkPanel(run, base);
    }
  };
  setTimeout(poll, 4000);            // shortly after load, then steady cadence
  setInterval(poll, 20000);
}
try { startBackgroundAutoworkWatcher(); } catch (_e) { /* watcher is best-effort */ }


// Vision: send an uploaded image to a vision model (Claude / GPT-4o, server-side) and render
// the answer. Used when the user attaches an image via "+" and asks about it.
function renderVisionAnswer(prompt, attachment) {
  const messages = document.getElementById('messages');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML = `<div class="msg-label">Unisona</div><div class="bubble" style="font-size:13px">Looking at <b>${esc(attachment.name)}</b>…</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();
  const bubble = row.querySelector('.bubble');
  fetch('/api/vision/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image: attachment.image, mimeType: attachment.mimeType }),
  })
    .then(r => r.json())
    .then(d => {
      if (d && d.ok && d.text) {
        bubble.innerHTML = (typeof renderMarkdown === 'function' ? renderMarkdown(d.text) : esc(d.text))
          + `<div style="opacity:.5;font-size:11px;margin-top:4px">👁 vision · ${esc(d.model || 'vision')}</div>`;
        persistToolTurn('lantern', d.text, { agent: 'Unisona', provider: 'vision', model: d.model || 'vision' });
      } else {
        const errMsg = `Couldn't analyze ${attachment.name}: ${(d && d.error) || 'vision unavailable'}`;
        bubble.innerHTML = `Couldn't analyze <b>${esc(attachment.name)}</b>: ${esc((d && d.error) || 'vision unavailable')}`;
        persistToolTurn('lantern', errMsg, { agent: 'Unisona', provider: 'vision' });
      }
      if (typeof scrollToBottom === 'function') scrollToBottom();
    })
    .catch(e => { bubble.innerHTML = `Vision error: ${esc(e.message)}`; if (typeof scrollToBottom === 'function') scrollToBottom(); persistToolTurn('lantern', `Vision error analyzing ${attachment.name}: ${e.message}`, { agent: 'Unisona', provider: 'vision' }); });
}


// ── Main send ─────────────────────────────────────────────────────────────────
async function sendMessage(opts = {}) {
  const input = document.getElementById('input');
  // "Ground this" retry path: re-run a specific message with forced web grounding
  // (groundedness canary loop). overrideText comes from the button, not the input
  // box — so we must not read or clear the box on this path.
  const overrideText = (opts && typeof opts.text === 'string') ? opts.text : null;
  const forceGround = !!(opts && opts.forceGround);
  // Auto-escalation (#1732): the groundedness canary fired this re-ground itself because
  // the prior reply was confident + unanchored (red band) — not a human click. Rides the
  // same forceGround path; used only to label the turn honestly.
  const autoVerify = !!(opts && opts.auto);
  // ── Single send entry ── These two checks used to be window.sendMessage WRAPPERS
  // (gatedSendMessage in chat.html + the !convergance shim in convergance-sync.js);
  // they're folded in here so there is exactly one sendMessage, no monkey-patching.
  // Auth gate: block roles without chat access (all current roles allow; the server
  // enforces real limits — this fails open to that if the role globals aren't present).
  try {
    if (typeof LANTERN_ROLES !== "undefined" && typeof lanternSession !== "undefined") {
      const _role = (typeof normalizeRole === "function") ? normalizeRole(lanternSession.role) : lanternSession.role;
      if (LANTERN_ROLES[_role] && !LANTERN_ROLES[_role].canChat) {
        if (typeof loginWithPatreon === "function") loginWithPatreon();
        return;
      }
    }
  } catch (_) { /* gate is best-effort; the server enforces limits regardless */ }
  const text = (overrideText != null ? overrideText : input.value).trim();
  if (!text || isSending) return;

  // Image attachment → vision: the user uploaded an image via "+" to ask about it. The image
  // is sent to a vision model (Claude / GPT-4o) so the chat can actually SEE it. Sticky, so
  // follow-up questions about the same image keep working until the chip is removed.
  const visionAttach = (window.pendingAttachments || []).find(a => a && a.image);
  if (visionAttach && text) {
    input.value = '';
    input.style.height = 'auto';
    addUserBubble(text);
    persistToolTurn('operator', text);
    renderVisionAnswer(text, visionAttach);
    return;
  }

  // ── No pre-LLM keyword/regex capability intercepts ──────────────────────────
  // Every typed message (except the image-attachment vision path above, which needs
  // the vision model, not a keyword) now flows straight to the LLM streaming path.
  // The model decides every capability — images, video, docs, jobs, web search, repo
  // work — via native tool calls (tool-runner.js), the way Claude/ChatGPT/Gemini do.
  // Do NOT reintroduce `parse*Request`/`detect*`/`!bang` early-returns here: they
  // caught keywords ("world" → Super Mario World) before the model ever ran. Enforced
  // by scripts/no-keyword-intent-routing.mjs.

  isSending = true;
  document.getElementById('send-btn').disabled = true;

  // #930: real cancellation — an AbortController the Stop button can trigger, plus a
  // 90s safety timer for a hung stream (replaces the old fire-and-forget timeout).
  let userStopped = false;
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), 90000);
  showStopButton(() => { userStopped = true; ac.abort(); });

  addUserBubble(forceGround && overrideText != null
    ? text + (autoVerify ? '  ↻ auto-verifying' : '  ↻ grounding')
    : text);
  // Don't clear the input box on a "Ground this" retry — the user didn't type this.
  if (overrideText == null) { input.value = ''; input.style.height = 'auto'; }
  history.push({ role: 'user', text });
  writeCubeDelta('chat_message', [], 'conversation:' + Date.now());

  const { msg, bubble, cursor, thinking } = createAgentBubble(false);
  const container = document.getElementById('messages');

  let fullText = '';
  let serverErrorText = '';
  let didError = false;
  let routeLabel = '';
  let receivedDone = false;
  let doneActions = null;   // convergence-agent action chips, from the done event (Stage 3)
  let doneProvider = '';
  let doneIntent = '';      // routed intent (coding_change, trading, …) — drives the autowork suggestion
  let doneModel = '';       // actual model id from the PCSF receipt (e.g. claude-haiku-4-5)
  let doneModelSwap = null; // capability-gated local-model swap decision (which local model led + why)
  let doneRouteReason = null; // #1554: why this turn routed here (taskType + provider-selection reason + gate)
  let doneTimestamp = '';   // receipt generatedAt — the signature timestamp
  let doneOnline = true;    // false when no model answered (offline path)
  // #930: coalesce per-token DOM writes into one render per animation frame instead
  // of re-parsing+re-rendering the whole bubble on every token.
  let rafId = 0;
  let rafPending = false;
  let streamEnded = false;
  const scheduleRender = () => {
    if (rafPending || streamEnded) return;
    rafPending = true;
    rafId = requestAnimationFrame(() => {
      rafPending = false;
      if (streamEnded) return;
      cursor.remove();
      bubble.innerHTML = renderMarkdown(fullText.replace(/\[DOORS:[^\]]*\]?/i, '').trimEnd());
      bubble.appendChild(cursor);
      container.scrollTop = container.scrollHeight;
    });
  };
  const toolResults = [];  // <tool_call> events arrive mid-stream; re-applied after the final render (which rebuilds the cards empty)
  const nativeToolCalls = [];  // cloud-model (Claude/OpenAI/Gemini) tool *calls* — they emit no <tool_call> text, so we synthesize the cards at finalize
  const requestedProvider = document.getElementById('provider-select')?.value || '';
  // The #1127 model pin (`requestedModel` from #model-select) was removed (#2476):
  // its markup was cut, so the value was always '' and no model was ever sent.

  try {
    const provider = requestedProvider;
    // Files attached via the "+" work tool — sent with this one turn, then cleared.
    // Forward text files AND images. Images carry a data URL (no extracted text) and the
    // server resolves them via the vision model — without this they were dropped here and
    // the model would report it received "0 files" despite a visible attachment (#1606).
    const sentAttachments = (window.pendingAttachments || [])
      .filter(a => a && (a.text || a.image))
      .map(a => (a.image && !a.text)
        ? { name: a.name, image: a.image, mimeType: a.mimeType }
        : { name: a.name, text: a.text });
    const resp = await fetch('/api/dream/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        user: 'dream-chat',
        provider,
        attachments: sentAttachments,
        history: history.slice(-10),
        personalContext: sanitizePersonalContext(personalContext || {}),
        // "Ground this" retry: force the server's web-search grounding branch.
        forceGround: forceGround || undefined,
        // Scope this turn to the active chat session so it persists into the Chats
        // drawer (#773). dream-chat.js owns the id and mirrors it to localStorage;
        // without it, turns log untagged and never form a saved session.
        sessionId: localStorage.getItem('lantern_chat_session') || undefined,
      }),
      signal: ac.signal,
    });
    // Attachments PERSIST across turns (work-tool semantics): the file content is re-sent each
    // turn so you can keep discussing/editing it. The chip stays visible; clear via the chip ×
    // or by starting a new chat. (Without this, a follow-up loses the file — only turn 1 has it.)

    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'route') {
            if (!bubble.querySelector('.route-card')) {
              const rc = document.createElement('div');
              rc.className = 'route-card';
              rc.textContent = evt.label || `${evt.agentName} · ${evt.surface}`;
              bubble.insertBefore(rc, cursor);
            }
            // Reflect routing in the spinner so users see real activity, not decorative spin.
            const _rl = thinking.querySelector('.thinking-label');
            if (_rl) { _rl.textContent = 'Researching…'; thinking.setAttribute('aria-label', 'Researching'); }
          } else if (evt.type === 'token' && evt.text) {
            if (thinking.parentNode) thinking.remove();
            fullText += evt.text;
            scheduleRender(); // #930: rAF-coalesced, not a full re-render per token
          } else if (evt.type === 'error') {
            didError = true;
            if (evt.text) serverErrorText = evt.text;
            if (!fullText) bubble.style.color = 'var(--muted)';
          } else if (evt.type === 'tool') {
            // Two shapes reach here:
            //  • native cloud loop → {phase:"call",name,input} then {phase:"result",name,ok,preview}
            //  • local Ouro path   → a single {name,input,ok,result} (its <tool_call> text already drew a card)
            // For native calls there is no text card, so record the call and synthesize
            // the card at finalize; results fill the last open card (and re-apply at the end).
            if (evt.phase === 'call') {
              nativeToolCalls.push({ name: evt.name, input: evt.input || {} });
              // Show "Checking <tool>…" so users understand what the delay is.
              const _tl = thinking.querySelector('.thinking-label');
              const readableTool = (evt.name || 'tool').replace(/_/g, ' ');
              if (_tl) { _tl.textContent = `Checking ${readableTool}…`; thinking.setAttribute('aria-label', `Checking ${readableTool}`); }
            } else {
              toolResults.push(evt);
              const cards = bubble.querySelectorAll('.tool-call-card');
              const card = cards[cards.length - 1];
              if (card) { fillToolSlot(card.querySelector('.tcc-result'), evt); container.scrollTop = container.scrollHeight; }
            }
          } else if (evt.type === 'sigma0' && evt.corrected) {
            // Response was revised by Σ₀ verify pass — show badge after stream completes
            bubble.dataset.sigma0Corrected = '1';
            bubble.dataset.sigma0Claims = evt.claims || 0;
          } else if (evt.type === 'done') {
            if (evt.cleanText) fullText = evt.cleanText;
            if (evt.routeLabel || evt.label) routeLabel = evt.routeLabel || evt.label;
            doneProvider = evt.source || evt.provider || (evt.receipt && evt.receipt.provider) || '';
            doneIntent = evt.intent || (evt.receipt && evt.receipt.intent) || '';
            doneModel = evt.model || (evt.receipt && evt.receipt.model) || '';
            doneModelSwap = evt.modelSwap || null;
            doneRouteReason = evt.routeReason || (evt.receipt && evt.receipt.routeReason) || null;
            doneTimestamp = evt.timestamp || (evt.receipt && evt.receipt.generatedAt) || '';
            doneOnline = evt.online !== false;
            if (Array.isArray(evt.actions) && evt.actions.length) doneActions = evt.actions;
            // Σ₀ groundedness canary (42-state guardrail): the reply asserted confident
            // claims with no external anchor. Flag it so the user knows it's self-
            // consistent but unverified, rather than letting it pass as grounded.
            if (evt.ungrounded) {
              bubble.dataset.ungrounded = '1';
              if (evt.sigma0_grounding && evt.sigma0_grounding.risk != null) {
                bubble.dataset.ungroundedRisk = String(evt.sigma0_grounding.risk);
              }
            }
            // 3-band groundedness verdict (#1731): green=pass · amber=offer · red=auto-verify.
            if (evt.groundedness && evt.groundedness.band) {
              bubble.dataset.groundednessBand = evt.groundedness.band;
            }
            // #1733: a forced grounding pass found no source → honest abstention framing.
            if (evt.abstained) bubble.dataset.abstained = '1';
            // Σ₀ council: the unified 4-way answerability verdict + disagreement Δ.
            if (evt.council && evt.council.verdict) {
              bubble.dataset.councilVerdict = String(evt.council.verdict);
              if (evt.council.delta != null) bubble.dataset.councilDelta = String(evt.council.delta);
              if (evt.council.recommend) bubble.dataset.councilRecommend = String(evt.council.recommend);
              // refuted-by-execution carries the failing test output — "wrong, with proof".
              if (evt.council.execFailed && evt.council.execOutput) {
                bubble.dataset.councilExecOutput = String(evt.council.execOutput);
              }
            }
            receivedDone = true;
          }
        } catch { /* skip malformed line */ }
      }
    }
  } catch (e) {
    // #930: a user Stop is a clean cancel — keep whatever already streamed. Any other
    // abort (the 90s safety timer) or error is a real failure.
    if (!(e && e.name === 'AbortError' && userStopped)) didError = true;
  } finally {
    clearTimeout(abortTimer);
    hideStopButton();
    streamEnded = true;            // stop scheduling and neutralize any in-flight rAF
    if (rafId) cancelAnimationFrame(rafId);
    isSending = false;
    document.getElementById('send-btn').disabled = false;
  }

  cursor.remove();

  // Truncation detection: stream ended without a done event and text looks cut off.
  // The badge is attached AFTER the final innerHTML render below — otherwise that
  // render wipes it out and the warning never shows.
  const looksTruncated = !!(fullText && !receivedDone);

  if (!fullText) {
    fullText = serverErrorText || FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
    msg.classList.add('error');
    bubble.style.color = 'var(--muted)';
    bubble.style.fontStyle = 'italic';
  }

  // Native cloud tool calls emit no <tool_call> text, and the done event replaces
  // fullText with the markup-free cleanText — so synthesize the markup now (above the
  // answer) so renderMarkdown draws the workflow cards and the re-apply below fills them.
  if (nativeToolCalls.length && !/<tool_call>/i.test(fullText)) {
    const blocks = nativeToolCalls.map(tc => '<tool_call>' + JSON.stringify(tc) + '</tool_call>').join('\n');
    fullText = blocks + '\n\n' + fullText;
  }

  bubble.innerHTML = renderMarkdown(fullText); // [DOORS:…] stripped inside renderMarkdown (#2497)

  // Persist the assistant turn NOW — immediately after the reply renders — so a throw
  // in any optional finalize decoration below (action chips, badges, TTS) can never
  // drop it from the send-history. This is the memory-loss fix: renderActionChips was
  // undefined and aborted finalize before the old tail-end push, so on a convergence
  // reply the model "forgot what it just said" on the next turn.
  if (!didError && fullText) history.push({ role: 'assistant', text: fullText });

  // Convergence-agent action chips (Stage 3): the server streamed a deterministic
  // work/ask answer + actions through the one endpoint — render the chips here.
  if (doneActions) {
    try {
      renderActionChips(bubble, doneActions, (typeof serverBase !== 'undefined') ? serverBase : window.location.origin);
    } catch (e) { console.warn('[dream-chat] action chips render failed:', e); }
  }

  // Re-apply tool results — the render above rebuilds the cards with empty result slots.
  if (toolResults.length) {
    const cards = bubble.querySelectorAll('.tool-call-card');
    toolResults.forEach((evt, i) => {
      const card = cards[i] || cards[cards.length - 1];
      if (card) fillToolSlot(card.querySelector('.tcc-result'), evt);
    });
  }

  // Group the synthesized native tool cards under ONE collapsed parent — the whole
  // workflow is rarely something the user needs expanded. (Single call: no parent.)
  if (nativeToolCalls.length > 1) {
    const group = [...bubble.querySelectorAll('.tool-call-card')].slice(0, nativeToolCalls.length);
    if (group.length > 1 && group[0].parentNode) {
      const parent = document.createElement('details');
      parent.className = 'tool-workflow';
      parent.style.cssText = 'border:1px solid var(--border,#2a2a3a);border-radius:10px;margin:8px 0;overflow:hidden';
      const sum = document.createElement('summary');
      sum.style.cssText = 'cursor:pointer;padding:6px 10px;background:rgba(92,200,255,.08);color:var(--accent,#5cc8ff);font-weight:600;font-size:13px;list-style:none';
      sum.textContent = '🔧 ' + group.length + ' tool calls';
      parent.appendChild(sum);
      group[0].parentNode.insertBefore(parent, group[0]);
      const inner = document.createElement('div');
      inner.style.cssText = 'padding:0 8px 4px';
      parent.appendChild(inner);
      group.forEach(c => { c.style.margin = '6px 0'; inner.appendChild(c); });
    }
  }

  if (looksTruncated) {
    const truncBadge = document.createElement('span');
    truncBadge.title = 'Stream ended without completing — response may be truncated';
    truncBadge.style.cssText = 'font-size:10px;opacity:0.5;margin-left:6px;vertical-align:middle;cursor:help';
    truncBadge.textContent = '⚠ truncated';
    bubble.appendChild(truncBadge);
  }

  if (bubble.dataset.sigma0Corrected && isSigma0OperatorView()) {
    const badge = document.createElement('span');
    badge.title = `Σ₀ verified — ${bubble.dataset.sigma0Claims} claim(s) grounded`;
    badge.style.cssText = 'font-size:10px;opacity:0.55;margin-left:6px;vertical-align:middle';
    badge.textContent = '✓ Σ₀';
    bubble.appendChild(badge);
  }

  // Σ₀ groundedness canary: confident claims, no external anchor (the 42-state).
  // Honest signal to the user — internally consistent but unverified. Suppressed
  // when Σ₀ verify already grounded the reply.
  if (bubble.dataset.abstained) {
    // #1733 honest abstention: a forced grounding pass found no external source for the
    // claims. Fail closed (BetterSafe doctrine) — say so plainly rather than re-badging
    // "ungrounded". The verified "could not ground" negative was logged server-side.
    const note = document.createElement('span');
    note.title = "I couldn't find an external source to verify these claims. Treat this as unverified.";
    note.style.cssText = 'font-size:10px;margin-left:6px;vertical-align:middle;color:#f5a623;cursor:help;opacity:0.95';
    note.textContent = '⚠ unverified — no source found';
    bubble.appendChild(note);
  } else if (bubble.dataset.ungrounded && !bubble.dataset.sigma0Corrected) {
    const risk = bubble.dataset.ungroundedRisk;
    const band = bubble.dataset.groundednessBand;
    // RED band — high-risk confident-unanchored — and we're online and this isn't already
    // a grounding retry: AUTO-ESCALATE. Fire the grounding pass without a human click, so
    // the loop self-corrects (Verify→Converge, #1732). The re-run carries forceGround:true,
    // so the `!forceGround` guard below stops it from escalating a second time.
    if (band === 'red' && doneOnline !== false && !forceGround) {
      const note = document.createElement('span');
      note.title = 'Confident claims with no external source — automatically re-answering with a live web search.';
      note.style.cssText = 'font-size:10px;margin-left:6px;vertical-align:middle;color:#f5a623;opacity:0.9';
      note.textContent = '↻ auto-verifying an unsourced claim…';
      bubble.appendChild(note);
      sendMessage({ text, forceGround: true, auto: true });
    } else if (isSigma0OperatorView()) {
      // AMBER (or red while offline): the honest passive badge. Operator-only (#2332) —
      // "⚠ ungrounded" / "🌐 Ground this" is Σ₀ grounding tooling and reads as an error
      // to a first-time consumer. Internally consistent but unverified, surfaced to operators.
      const badge = document.createElement('span');
      badge.title = 'Confident claims with no external source — self-consistent but unverified.'
        + (risk ? ` (Σ₀ groundedness risk ${risk})` : '');
      badge.style.cssText = 'font-size:10px;opacity:0.7;margin-left:6px;vertical-align:middle;color:#f5a623;cursor:help';
      badge.textContent = '⚠ ungrounded';
      bubble.appendChild(badge);
      // Actionable half: offer a one-click retry that re-runs THIS question with forced
      // web grounding — detect → actually ground, the 42-state loop closed in the UI.
      // Suppressed when we're online-less (web search can't reach reality) or when this
      // turn was already a forced-grounding retry (don't invite an endless re-ground).
      if (doneOnline !== false && !forceGround) {
        const reground = document.createElement('button');
        reground.type = 'button';
        reground.textContent = '🌐 Ground this';
        reground.title = 'Re-answer this question with a live web search for sources.';
        reground.style.cssText = 'font-size:10px;margin-left:8px;vertical-align:middle;color:var(--accent);background:none;border:1px solid currentColor;border-radius:4px;padding:1px 6px;cursor:pointer;opacity:0.85';
        reground.addEventListener('click', () => {
          reground.disabled = true;
          sendMessage({ text, forceGround: true });
        });
        bubble.appendChild(reground);
      }
    }
  }

  // Σ₀ council: the unified 4-way answerability verdict (grounded / seam-open / pin / refuted)
  // + the disagreement Δ. A subtle chip beside the reply; grounded is the quiet healthy case.
  // Operator-only (#2332): the raw "Σ₀ seam-open/pin/refuted" labels are internal jargon that
  // reads as an error to consumers. The refuted→retry exec-output affordance goes with it.
  if (bubble.dataset.councilVerdict && isSigma0OperatorView()) {
    const v = bubble.dataset.councilVerdict;
    const d = bubble.dataset.councilDelta;
    const MAP = {
      grounded:  ['✓ Σ₀ grounded',  '#6ee7b7', '0.5'],
      seam_open: ['⚠ Σ₀ seam-open', '#f5a623', '0.85'],
      pin:       ['? Σ₀ pin',       '#9ca3af', '0.7'],
      refuted:   ['✗ Σ₀ refuted',   '#f87171', '0.9'],
    };
    const m = MAP[v] || ['Σ₀ ' + v, '#9ca3af', '0.6'];
    const badge = document.createElement('span');
    badge.title = 'Σ₀ council verdict: ' + v + (d ? ' (disagreement Δ ' + d + ')' : '')
      + ' — grounded = trust it; seam-open = unverified, go check; pin = no knowable answer; '
      + 'refuted = failed a real check.';
    badge.style.cssText = 'font-size:10px;margin-left:6px;vertical-align:middle;cursor:help;color:'
      + m[1] + ';opacity:' + m[2];
    badge.textContent = m[0];
    bubble.appendChild(badge);

    // Refuted by a real execution check: the code ran and failed its own asserts. Surface
    // the failure output ("wrong, with proof") and a one-click retry that re-asks WITH that
    // proof attached, so the model self-corrects — the refuted → retry loop, closed in the UI.
    if (v === 'refuted' && bubble.dataset.councilExecOutput) {
      const out = bubble.dataset.councilExecOutput;
      const det = document.createElement('details');
      det.style.cssText = 'margin:6px 0 0;font-size:11px';
      const sum = document.createElement('summary');
      sum.textContent = '✗ test failed — show output';
      sum.style.cssText = 'cursor:pointer;color:#f87171;list-style:none;user-select:none';
      det.appendChild(sum);
      const pre = document.createElement('pre');
      pre.textContent = out;
      pre.style.cssText = 'margin:6px 0 0;padding:8px;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);border-radius:6px;white-space:pre-wrap;overflow-x:auto;color:var(--text,#ddd)';
      det.appendChild(pre);
      bubble.appendChild(det);

      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '🔧 Fix & retry';
      retry.title = 'Re-ask with the failing test output attached so the model corrects its code.';
      retry.style.cssText = 'display:block;margin:6px 0 0;font-size:11px;color:var(--accent);background:none;border:1px solid currentColor;border-radius:4px;padding:2px 8px;cursor:pointer;opacity:0.9';
      retry.addEventListener('click', () => {
        retry.disabled = true;
        sendMessage({ text: text + '\n\n[Your previous code failed this check:\n' + out + '\n]\nFix it so the test passes.' });
      });
      bubble.appendChild(retry);
    }
  }

  // In-chat PR review (#1503 follow-up): when this turn was a `!review #N` (the server
  // tags the done event source "review"), attach Approve / Discard so the user can
  // accept or reject the reviewed PR without leaving chat — closing the
  // work → review → accept loop in one surface. PR number comes from the sent text.
  if (doneProvider === 'review' && !didError) {
    const _prm = String(text || '').match(/#?(\d+)/);
    if (_prm) renderPrReviewActions(bubble, parseInt(_prm[1], 10), (typeof serverBase !== 'undefined') ? serverBase : window.location.origin);
  }

  // Deterministic `!work #N` (server tags the done event source "work", mirroring
  // !review): start the observable autowork run panel on that issue. The server route
  // only validates + tags — the client owns the one panel path (runAutowork), so
  // command-started and offer-started runs render identically. `btn` is null here
  // (no offer button exists); runAutowork guards it.
  if (doneProvider === 'work' && !didError) {
    const _wm = String(text || '').match(/#?(\d+)/);
    if (_wm) runAutowork(parseInt(_wm[1], 10), null, (typeof serverBase !== 'undefined') ? serverBase : window.location.origin).catch(() => {});
  }

  // Signature line: always show a human-readable label + time. Raw provider/model id
  // goes in a collapsed <details> so curious users can inspect it without it cluttering
  // every reply for normal users. (#1141)
  if (!didError) {
    const sig = document.createElement('div');
    sig.className = 'msg-route-sig';
    const t = doneTimestamp ? new Date(doneTimestamp) : new Date();
    const time = isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // Human-readable label: "Unisona · chat" or the agent route label.
    const displayLabel = routeLabel || 'Unisona · chat';
    if (doneOnline === false) {
      // Offline path: make it explicit for the user.
      sig.textContent = `${displayLabel} · offline${time ? ' · ' + time : ''}`;
      sig.setAttribute('aria-label', `Unisona replied offline${time ? ' at ' + time : ''}`);
    } else {
      const pm = [doneProvider, doneModel].filter(Boolean).join('/');
      // Visible part: label + time only.
      const visibleText = [displayLabel, time].filter(Boolean).join(' · ');
      // Capability-gated local-model swap (lib/local-model-registry.js): when a
      // LOCAL model answered, show WHICH model led so the auto-swap is visible —
      // the cockpit telling you what's under the hood, not a warning. The model is
      // interchangeable by design (Σ₀ North Star); the reason is a hover tooltip.
      let swapChip = '', swapTitle = '', swapDebug = '';
      if (doneModelSwap && (doneModelSwap.served || doneModelSwap.lead)) {
        const _e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
        const served = doneModelSwap.served || doneModelSwap.lead;
        const fellThrough = doneModelSwap.lead && served !== doneModelSwap.lead;
        swapTitle = `Auto-selected ${served} — ${doneModelSwap.reason || 'local model'}` +
          (fellThrough ? ` (lead ${doneModelSwap.lead} wasn't serving)` : '') +
          '. Models are interchangeable (Σ₀); pick a provider in Settings to override.';
        swapChip = ` · <span class="model-swap-chip" title="${_e(swapTitle)}" style="opacity:0.6">⇄ ${_e(served)}</span>`;
        const cand = Array.isArray(doneModelSwap.candidates) ? doneModelSwap.candidates.join(' → ') : '';
        swapDebug = `<div style="margin-top:2px">swap: ${_e(doneModelSwap.reason || '')}${cand ? ' · chain: ' + _e(cand) : ''}</div>`;
      }
      // #1554 — capability-gated routing, observable: assemble WHY this turn routed
      // to this model (server routeReason = task classification + provider-selection
      // reason + optional conversation-gate note). Surfaced as a hover tooltip on the
      // signature label and expanded in the route disclosure below.
      const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
      let routeReasonText = '';
      if (doneRouteReason && (doneRouteReason.why || doneRouteReason.taskType)) {
        const rp = [];
        if (doneRouteReason.taskType) rp.push(doneRouteReason.taskType);
        if (doneRouteReason.why) rp.push(doneRouteReason.why);
        if (doneRouteReason.gate) rp.push('gate: ' + doneRouteReason.gate);
        routeReasonText = rp.join(' · ');
      }
      const routeTitle = routeReasonText ? ` title="routed: ${esc(routeReasonText)}"` : '';
      const routeDebug = routeReasonText ? `<div style="margin-top:2px">route: ${esc(routeReasonText)}</div>` : '';
      // #1926: the provider/model + route-reason disclosure is developer chrome — it
      // reads as "debug route" internals to a normal user. Keep it available for
      // operators (#1554 made routing observable on purpose) but OFF by default: render
      // it only when the debug toggle is set (localStorage `lantern_chat_debug` = "1",
      // or ?debug=1 on the URL). The visible label + swap chip (the cockpit "which model"
      // signal) always show; only the route internals are gated.
      if (pm) {
        // #2126: always expose which model actually answered — a collapsed ▸ debug
        // disclosure carrying the provider/model, so the receipt is never missing.
        // The verbose route internals (swap chain + route reason, #1554) stay
        // operator-only behind the debug toggle (#1926) to keep the default clean.
        const showRouteInternals = debugChromeOn();
        const summaryLabel = showRouteInternals ? '▸ route' : '▸ debug';
        const extras = showRouteInternals ? `${swapDebug}${routeDebug}` : '';
        sig.innerHTML =
          `<span${routeTitle}>${visibleText}${swapChip}</span>` +
          `<details class="sig-debug" style="display:inline-block;margin-left:6px">` +
          `<summary style="display:inline;cursor:pointer;font-size:10px;opacity:0.45;list-style:none" aria-label="Model and route details">${summaryLabel}</summary>` +
          `<span class="sig-debug-body" style="font-size:10px;opacity:0.55;margin-left:4px">${pm}${extras}</span>` +
          `</details>`;
        sig.setAttribute('aria-label', `Unisona replied${time ? ' at ' + time : ''}; model: ${pm}` + (routeReasonText ? `; routed: ${routeReasonText}` : '') + (swapTitle ? `; ${swapTitle}` : ''));
      } else {
        sig.innerHTML = `<span${routeTitle}>${visibleText}${swapChip}</span>`;
        sig.setAttribute('aria-label', `Unisona replied${time ? ' at ' + time : ''}` + (routeReasonText ? `; routed: ${routeReasonText}` : '') + (swapTitle ? `; ${swapTitle}` : ''));
      }
    }
    msg.appendChild(sig);
  }

  // ── Suggest-then-confirm: offer to run a coding turn as autowork → linked PR ──
  // Coding-intent chats answer normally above; here we surface a one-click action
  // that files an issue from the request and runs the autowork pipeline (cloud
  // model → patch → tests → draft PR). No PR is opened unless the user clicks.
  const CODING_INTENTS = ['coding_change', 'coding', 'technical_debug', 'code_review', 'code'];
  // #1344: a pure read/lookup ("find/show/view/read/summarize issue/PR #N") is keyword-
  // classified as "code" (it mentions "issue"/"github"), which used to surface the
  // autowork offer — and clicking it filed a REAL GitHub issue with the raw query as
  // title+body, then ran a doomed patch pipeline (nothing to change). Suppress the offer
  // for lookups that carry no change-verb, so "find issue #1342" just answers (now via
  // the github_issue tool) instead of offering to open a PR.
  const _looksLikeLookup =
    /\b(find|show|view|read|open|get|look\s*up|summar|explain|describe|what'?s?|tell me about|details? (on|of|about))\b/i.test(text) &&
    /\b(issue|pr|pull request|ticket|bug report)\b\s*#?\d+/i.test(text) &&
    !/\b(fix|implement|add|change|edit|patch|refactor|rewrite|update the code|resolve|close|work on|build|create a)\b/i.test(text);
  // #1964: personal document work ("update my resume", "make me a cover letter")
  // keyword-classifies as a code intent via change-verbs like "update" — but it is
  // not repo work, so offering to file an issue + open a PR is nonsense there.
  // Server-side the document_request intent now catches these; this is the belt
  // for older servers / misclassified turns.
  // #1925: also cover the job-search vocabulary the transcript called out. A message
  // like "review my job application" or "help me apply for this GitHub job" trips a
  // code intent (via "review"/"github") yet is career work, not repo work. Kept
  // narrow — bare "apply"/"application" is NOT matched (they mean apply-a-patch /
  // web-application in real coding asks); only explicit job-search phrasing is.
  const _looksLikeDocument =
    /\b(resume|cover letter|cover-letter|cv|docx|word (doc|document)|essay|memo|spreadsheet|presentation|slide deck|personal statement|letter of (intro|introduction|interest|recommendation))\b/i.test(text) ||
    /\b(job (application|applications|posting|postings|search|hunt|offer)|interview prep)/i.test(text) ||
    /\bapply(ing)? (for|to)\b.{0,40}?\b(job|position|role|internship|posting|opening|vacancy)\b/i.test(text);
  if (!didError && doneOnline !== false && CODING_INTENTS.includes(doneIntent) && !_looksLikeLookup && !_looksLikeDocument) {
    const offer = document.createElement('div');
    offer.className = 'autowork-offer';
    offer.style.cssText = 'margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    const awBtn = document.createElement('button');
    awBtn.type = 'button';
    awBtn.className = 'autowork-run-btn';
    awBtn.style.cssText = 'font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--accent,#5cc8ff);background:transparent;color:var(--accent,#5cc8ff);cursor:pointer';
    awBtn.textContent = 'Run as autowork →';
    awBtn.title = 'Files a GitHub issue for this request, then has a cloud model patch it, run tests, and open a linked draft PR.';
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:11px;opacity:0.55';
    hint.textContent = 'opens a draft PR';
    awBtn.addEventListener('click', () => {
      awBtn.disabled = true;
      awBtn.textContent = 'Running…';
      const base = (typeof serverBase !== 'undefined') ? serverBase : window.location.origin;
      runAutowork({ task: text }, awBtn, base).catch(err => {
        console.error('[autowork]', err);
        awBtn.textContent = '✗ Error';
      });
    });
    offer.appendChild(awBtn);
    offer.appendChild(hint);
    msg.appendChild(offer);
  }

  // Degraded-mode notice (#740): the answer came from the local model as a silent
  // fallback because the cloud providers failed — not because the user chose local.
  // A small local model often ignores the system prompt and answers off-tone, so
  // surface it honestly. `provider` is what the user requested ('' = auto).
  if (!didError && doneProvider === 'ollama' && requestedProvider !== 'ollama') {
    const warn = document.createElement('div');
    warn.className = 'msg-route-sig degraded';
    warn.setAttribute('role', 'note');
    warn.style.cssText = 'font-size:11px;color:#f5a623;margin-top:2px;';
    warn.textContent = '⚠ Offline — answered by the local model (cloud providers unavailable). Quality may be lower.';
    msg.appendChild(warn);
  }

  // 🔊 Read-aloud + narration. This file is the live reply renderer, so TTS must live
  // here — the equivalent code in dream-chat.js runs on a dead render path, which is why
  // replies never read back. Reuses window.speakText (server TTS → browser fallback). (#858)
  // Narration reads the ANSWER only — never the tool calls. Strip <tool_call> markup
  // (and the hidden [DOORS] tag) so the narrator doesn't read raw JSON / tool I/O aloud;
  // the user opens a tool card deliberately if they want its detail.
  const speakableText = (fullText || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_call>[\s\S]*$/i, '')
    .replace(/\[DOORS:[^\]]*\]?/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!didError && speakableText && typeof window.speakText === 'function') {
    const speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'read-aloud-btn';
    speakBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:13px;opacity:0.6;margin-top:4px;padding:2px 4px;color:var(--accent,inherit);';
    speakBtn.textContent = '🔊 Read aloud';
    speakBtn.setAttribute('aria-label', 'Read this reply aloud');
    const resetSpeakBtn = () => {
      speakBtn.dataset.speaking = '';
      speakBtn.textContent = '🔊 Read aloud';
      if (window.__activeReadReset === resetSpeakBtn) window.__activeReadReset = null;
    };
    const startSpeaking = () => {
      if (window.__activeReadReset) window.__activeReadReset();  // reset whichever reply was speaking
      window.__activeReadReset = resetSpeakBtn;
      speakBtn.dataset.speaking = '1';
      speakBtn.textContent = '⏹ Stop';
      window.speakText(speakableText, resetSpeakBtn);
    };
    speakBtn.addEventListener('click', () => {
      if (speakBtn.dataset.speaking === '1') {
        if (typeof window.stopSpeaking === 'function') window.stopSpeaking();
        resetSpeakBtn();
      } else {
        startSpeaking();
      }
    });
    msg.appendChild(speakBtn);
    // Global narrate toggle (🔊 nav button sets window.narrateReplies): speak automatically.
    if (window.narrateReplies) startSpeaking();
  }

  // Per-message feedback (#1965) — the Observe-stage preference signal. Each verdict is
  // attributable to the provider/model that actually served this turn (done receipt), so
  // per-provider win rates are measurable from the ledger. Best-effort: never breaks chat.
  if (!didError && fullText) {
    const fbTurnIndex = history.length; // this assistant turn's transcript index (user turn already pushed)
    const fbRow = document.createElement('div');
    fbRow.className = 'msg-feedback';
    fbRow.style.cssText = 'display:flex;gap:2px;margin-top:2px;';
    const fbBtn = (verdict, glyph, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'feedback-btn';
      b.dataset.verdict = verdict;
      b.style.cssText = 'background:none;border:none;cursor:pointer;font-size:13px;opacity:0.6;padding:2px 4px;';
      b.textContent = glyph;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        for (const o of fbRow.querySelectorAll('.feedback-btn')) { o.style.opacity = '0.6'; o.setAttribute('aria-pressed', 'false'); }
        b.style.opacity = '1';
        b.setAttribute('aria-pressed', 'true');
        fetch('/api/dream/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            verdict,
            turnIndex: fbTurnIndex,
            sessionId: localStorage.getItem('lantern_chat_session') || undefined,
            provider: doneProvider, model: doneModel, intent: doneIntent, routeLabel,
            userPreview: text.slice(0, 160), replyPreview: fullText.slice(0, 160),
            surface: 'dream-chat',
          }),
        }).catch(() => {}); // ledger append is best-effort; a miss must never break the chat
      });
      return b;
    };
    fbRow.appendChild(fbBtn('up', '👍', 'Good reply'));
    fbRow.appendChild(fbBtn('down', '👎', 'Bad reply'));
    msg.appendChild(fbRow);
  }

  // (the assistant turn was pushed to history right after the reply rendered, above,
  // so an error in any decoration between there and here can't erase it)
}

// ── Auto-expand textarea ──────────────────────────────────────────────────────
document.getElementById('input').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
});


// ── Handoff prefill (?seed=) ──────────────────────────────────────────────────
// Lets other surfaces (e.g. /orchestration.html) hand a task into Unisona chat.
// Prefills the composer but never auto-sends — the human reviews/edits first.
(function applySeedPrompt() {
  try {
    const seed = new URLSearchParams(location.search).get('seed');
    if (seed && typeof fillPrompt === 'function') {
      hideEmptyState();
      fillPrompt(seed.slice(0, 2000));
    }
  } catch (e) { /* no-op */ }
})();

// ── Provider dropdown: built dynamically from /api/providers/status ─────────────
// The provider list is NOT hardcoded. It is built from what the running server can
// actually dispatch to, so a provider only appears when its key is live, and the
// local Σ₀ (Ouro) option appears only when a model is really being served on :11434
// — labeled with the real model, never a static fiction. Auto is always present and
// the default. This also absorbs the old ?provider= handoff (from home/orchestration):
// the requested provider is honored only if it is a live option now.
(function buildProviderDropdown() {
  const select = document.getElementById('provider-select');
  if (!select) return;
  // dropdown value → { label, bucket } where bucket is the /api/providers/status key.
  // keystone-ft is a local fine-tune served through ollama, so it shares that bucket
  // (and is only offered when a matching tag is actually being served).
  const CATALOG = [
    { value: 'claude',      label: 'Claude',      bucket: 'anthropic'  },
    { value: 'openai',      label: 'ChatGPT',     bucket: 'openai'     },
    { value: 'gemini',      label: 'Gemini',      bucket: 'gemini'     },
    { value: 'grok',        label: 'Grok',        bucket: 'xai'        },
    { value: 'deepseek',    label: 'DeepSeek',    bucket: 'deepseek'   },
    { value: 'mistral',     label: 'Mistral',     bucket: 'mistral'    },
    { value: 'perplexity',  label: 'Perplexity',  bucket: 'perplexity' },
    { value: 'cohere',      label: 'Cohere',      bucket: 'cohere'     },
    { value: 'ollama',      label: 'Local Σ₀',    bucket: 'ollama', local: true },
    { value: 'keystone-ft', label: 'unisona.ai FT', bucket: 'ollama', local: true },
  ];

  function applyRequestedProvider() {
    // Honor ?provider= handoff, but only if that provider is a live option now;
    // otherwise fall back to Auto/router default rather than dispatch-failing.
    try {
      const provider = new URLSearchParams(location.search).get('provider');
      if (provider) {
        if (select.querySelector(`option[value="${provider}"]`)) select.value = provider;
        else if (provider !== 'auto') console.warn(`[dream-chat] Requested provider '${provider}' not live, using router default`);
      }
    } catch { /* no-op */ }
    select.dispatchEvent(new Event('change', { bubbles: true })); // let the Model sub-dropdown + gating update
  }

  // The page's boot burst can abort a single status fetch (connection-pool
  // starvation), so retry a few times before giving up — otherwise the dropdown
  // silently falls back to the full catalog on every load, reintroducing the very
  // fake "Local Σ₀" option this is meant to remove.
  async function fetchStatus() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch('/api/providers/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (r.ok) return (await r.json()).providers || null;
      } catch { /* boot-burst abort / status down — retry */ }
      await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
    }
    return null;
  }

  async function build() {
    const providers = await fetchStatus();
    select.innerHTML = '<option value="">Auto (pick best)</option>';
    for (const entry of CATALOG) {
      const p = providers && providers[entry.bucket];
      // With status: show only what's genuinely available. Without it (rare, after
      // retries): show cloud providers optimistically (dispatch falls back if needed)
      // but NEVER an unconfirmed local option — advertising one is the fake-option bug.
      const isLive = providers ? !!(p && p.available) : !entry.local;
      if (!isLive) continue;
      let label = entry.label;
      if (entry.bucket === 'ollama' && p) {
        if (entry.value === 'ollama') {
          const m = p.active_model || p.model;
          label = (m && m !== 'auto') ? `Local Σ₀ (${m})` : 'Local Σ₀';
        } else if (entry.value === 'keystone-ft') {
          // Only offer keystone-ft when a matching tag is actually served.
          const served = (p.served_models || []).map((s) => String(s).toLowerCase());
          if (!served.some((s) => s.includes('keystone') || s.includes('-ft'))) continue;
        }
      }
      const o = document.createElement('option');
      o.value = entry.value;
      o.textContent = label;
      const model = p && p.model;
      if (model && model !== 'auto') o.title = model; // concrete model id on hover
      select.appendChild(o);
    }
    applyRequestedProvider();
    if (typeof window.gateProviderOptions === 'function') window.gateProviderOptions();
  }

  build();
})();

// The model sub-picker (wireModelSelect, #1127) and the Observer side panel
// (toggleObserver/refreshObserver + its 30s poll) were removed (#2476): their
// markup was cut long ago, so the picker IIFE early-returned forever and the
// observer JS polled /api/csf/* into a permanently hidden, opener-less panel.
