// ── Deterministic tool-flow persistence (#1268) ──────────────────────────────
// Image/video/vision/doc-gen requests are handled entirely client-side (no LLM
// call), so they never hit /api/dream/chat — which means they never reached the
// server's appendConversationEntry either. A reload or session-switch replayed
// from server storage and these turns just vanished. POST them directly to the
// existing /api/conversations endpoint so they survive like normal chat turns.
function persistToolTurn(role, text, meta) {
  if (!text) return;
  try {
    const sessionId = localStorage.getItem('lantern_chat_session') || null;
    fetch('/api/conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, text, surface: 'garage', sessionId, ...(meta ? { meta } : {}) }),
    }).catch(() => {}); // best-effort — a failed persist must never break the live reply
  } catch { /* best-effort */ }
}

// ── Tool-turn replay (#1270) ─────────────────────────────────────────────────
// Rebuild the rich bubble content (generated image, YouTube embed, document
// download) from a persisted meta.tool payload, so reloading or switching back to
// a session restores the actual element — not just its text description. The
// markup here mirrors the live renderers (renderWebImage / renderYoutube /
// renderDocGen). Returns inner-HTML for the .bubble, or null to fall back to text.
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
    const resp = await fetch('/api/cubes/alex/personal');
    if (resp.ok) {
      personalContext = await resp.json();
      updatePersonalInsights(personalContext);
    } else {
      personalContext = { error: 'API unavailable', timestamp: new Date().toISOString() };
    }
  } catch (e) {
    personalContext = { error: 'Network error', timestamp: new Date().toISOString() };
  }
}

function updatePersonalInsights(cube) {
  const githubBadge = document.getElementById('github-status-badge');
  if (githubBadge && cube.github) {
    const openIssues = cube.github.issues?.filter(i => i.state === 'open').length || 0;
    const openPRs = cube.github.prs?.filter(p => p.state === 'open').length || 0;
    githubBadge.textContent = `GitHub: ${openIssues} issues, ${openPRs} PRs`;
    githubBadge.style.display = 'block';
  }
  if (cube.providers) {
    for (const [provider, status] of Object.entries(cube.providers)) {
      const indicator = document.getElementById(`provider-${provider}-status`);
      if (indicator) {
        indicator.className = status.configured ? 'status-indicator ok' : 'status-indicator err';
        indicator.textContent = status.configured ? '✓' : '✗';
      }
    }
  }
  if (cube.environment) {
    const envStatus = document.getElementById('environment-status');
    if (envStatus) {
      const serverStatus = cube.environment.server?.running ? 'Running' : 'Stopped';
      const gitStatus = cube.environment.git?.isDirty ? 'Dirty' : 'Clean';
      envStatus.textContent = `Env: ${serverStatus}, Git: ${gitStatus}`;
    }
  }
  if (cube.priorities && cube.priorities.nextActions) {
    const prioritiesPanel = document.getElementById('priorities-panel');
    if (prioritiesPanel) {
      prioritiesPanel.innerHTML = cube.priorities.nextActions.map(p =>
        `<div class="priority-item">
          <span class="priority-badge ${p.priority}">${p.priority}</span>
          <span class="priority-title">#${p.number}: ${p.title}</span>
        </div>`
      ).join('');
    }
  }
}

loadPersonalCube();
setInterval(loadPersonalCube, 300000);

// ── Modal controls ────────────────────────────────────────────────────────────
function openSettings() { document.getElementById('settings-modal').classList.add('open'); }
function closeSettings() { document.getElementById('settings-modal').classList.remove('open'); }

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

// ── Connector sidecar ─────────────────────────────────────────────────────────
function focusKey(inputId) {
  const el = document.getElementById(inputId);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
}

async function updateConnectorStatuses() {
  try {
    const r = await fetch('http://127.0.0.1:8772/health', { method: 'GET', mode: 'cors', cache: 'no-store' });
    const mcpStatus = document.getElementById('mcp-status');
    const mcpBtn = document.getElementById('mcp-btn');
    if (r.ok) {
      mcpStatus.textContent = 'Connected';
      mcpStatus.className = 'connector-card-status ok';
      mcpBtn.textContent = 'Disconnect';
      mcpBtn.onclick = disconnectMcp;
      mcpBtn.classList.remove('primary');
    } else { throw new Error('HTTP ' + r.status); }
  } catch (e) {
    const mcpStatus = document.getElementById('mcp-status');
    const mcpBtn = document.getElementById('mcp-btn');
    if (mcpStatus) { mcpStatus.textContent = 'Disconnected'; mcpStatus.className = 'connector-card-status pending'; }
    if (mcpBtn) { mcpBtn.textContent = 'Connect'; mcpBtn.onclick = connectMcp; mcpBtn.classList.add('primary'); }
  }

  // Provider connector badges — authoritative source is server /api/settings/providers.
  // localStorage is a fallback for offline mode only.
  const providers = [
    { key: 'ANTHROPIC_API_KEY', id: 'claude' },
    { key: 'GEMINI_API_KEY', id: 'gemini' },
    { key: 'OPENAI_API_KEY', id: 'openai' },
    { key: 'XAI_API_KEY', id: 'grok' },
  ];

  let serverKeys = null;
  try {
    const pr = await fetch('/api/settings/providers', { signal: AbortSignal.timeout(3000) });
    if (pr.ok) serverKeys = await pr.json();
  } catch { /* fall through to localStorage */ }

  for (const p of providers) {
    const badge = document.getElementById('conn-status-' + p.id);
    if (!badge) continue;

    // Prefer server truth; fall back to input field or localStorage
    const serverConfigured = serverKeys ? !!(serverKeys[p.key]) : null;
    const input = document.getElementById('key-' + p.id);
    const localConfigured = !!localStorage.getItem(p.key) || !!(input && input.value.length > 0);
    const configured = serverConfigured !== null ? serverConfigured : localConfigured;

    badge.textContent = configured ? 'Connected' : 'No key';
    badge.className = `connector-card-status ${configured ? 'ok' : 'err'}`;
  }
}

async function connectMcp() {
  const mcpStatus = document.getElementById('mcp-status');
  const mcpBtn = document.getElementById('mcp-btn');
  mcpStatus.textContent = 'Connecting…';
  mcpStatus.className = 'connector-card-status pending';
  mcpBtn.disabled = true;
  try {
    const health = await fetch('http://127.0.0.1:8772/health', { method: 'GET', mode: 'cors', cache: 'no-store' });
    if (!health.ok) throw new Error('MCP server not responding');
    const width = 500, height = 600;
    const left = (screen.width - width) / 2, top = (screen.height - height) / 2;
    const popup = window.open(
      'http://127.0.0.1:8772/oauth/register?client_name=LanternOSJournal&redirect_uri=http://127.0.0.1:4177/oauth/callback',
      'mcpOAuth', `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
    );
    const checkClosed = setInterval(() => {
      if (popup.closed) { clearInterval(checkClosed); updateConnectorStatuses(); mcpBtn.disabled = false; }
    }, 500);
  } catch (e) {
    mcpStatus.textContent = 'Error'; mcpStatus.className = 'connector-card-status err';
    mcpBtn.disabled = false;
    alert('MCP connection failed: ' + e.message);
  }
}

function disconnectMcp() {
  localStorage.removeItem('MCP_OAUTH_TOKEN');
  updateConnectorStatuses();
}

async function testWebSearch() {
  const btn = event.target;
  const original = btn.textContent;
  btn.textContent = 'Testing…'; btn.disabled = true;
  try {
    const r = await fetch('http://127.0.0.1:8772/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'Keystone OS', max_results: 3 } } }),
    });
    const data = await r.json();
    if (data.result && data.result.success) {
      alert('Web search works! Found ' + data.result.result_count + ' results.\nTop: ' + (data.result.results[0]?.title || '?'));
    } else {
      alert('Web search returned: ' + (data.result?.error || 'unknown error'));
    }
  } catch (e) { alert('Web search test failed: ' + e.message); }
  finally { btn.textContent = original; btn.disabled = false; }
}

// Refresh connector statuses when settings opens
const _origOpenSettings = openSettings;
openSettings = function() { _origOpenSettings(); updateConnectorStatuses(); };

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
  // Extract tool-call blocks (closed, then a trailing unclosed one while streaming)
  // into placeholders that survive HTML-escaping; restore as cards at the very end.
  const _toolCards = [];
  text = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (_, inner) => '\x00T' + (_toolCards.push(buildToolCard(inner, false)) - 1) + '\x00');
  text = text.replace(/<tool_call>\s*([\s\S]*)$/i, (_, inner) => '\x00T' + (_toolCards.push(buildToolCard(inner, true)) - 1) + '\x00');
  let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  h = h.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre class="code-block"><code>$1</code></pre>');
  h = h.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

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

  h = h.replace(/\n/g, '<br>');
  h = h.replace(/\x00T(\d+)\x00/g, (_, i) => _toolCards[+i]);  // restore tool-call cards last (after <br>) so their <pre> isn't mangled
  return h;
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
  "No AI providers are set up. Add an API key in Settings (⚙) to get started.",
  "All providers offline. Check Settings to add an API key or start a local model.",
  "Connection quiet. Try again in a moment, or check Settings for API keys.",
  "No provider answered. Open Settings (⚙) to configure Gemini, Claude, or OpenAI.",
  "AI unavailable. Add a provider key in Settings, or run: ollama serve for local mode.",
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

// ── Chat command registry (Claude-Code-style "!"/"/" commands) ─────────────────
// Single source of truth for: the command palette (type ! or / to autocomplete),
// the !help listing, and slash-parity normalization. Only commands that actually
// work in the live path are listed, so the palette never advertises a dead one.
const COMMANDS = [
  { name: 'help',        group: 'Chat',    usage: '!help',             desc: 'List every chat command' },
  { name: 'ask',         group: 'Chat',    usage: '!ask <question>',   desc: 'Force a web-grounded, cited answer' },
  { name: 'search',      group: 'Chat',    usage: '!search <query>',   desc: 'Web search and summarize', aliases: ['web-search'] },
  { name: 'issues',      group: 'Build',   usage: '!issues',           desc: 'Browse open issues — one click runs autowork', aliases: ['backlog'] },
  { name: 'work',        group: 'Build',   usage: '!work #123',        desc: 'Run keystone autowork on an issue → linked PR', aliases: ['edit'] },
  { name: 'review',      group: 'Build',   usage: '!review #123',      desc: 'Review a pull request’s diff right in the chat' },
  { name: 'prs',         group: 'Build',   usage: '!prs',              desc: 'Browse open PRs — one click reviews each (also: “review pull requests”)', aliases: ['pull-requests', 'pullrequests', 'review-prs'] },
  { name: 'convergence', group: 'Build',   usage: '!convergence',      desc: 'Run the convergence loop + fleet/version status', aliases: ['convergance', 'converge'] },
  { name: 'code',        group: 'Build',   usage: '!code <task>',      desc: 'Coding turn on the cloud coder' },
  { name: 'self-edit',   group: 'Build',   usage: '!self-edit <task>', desc: 'Plan an edit to Keystone’s own code', aliases: ['selfedit'] },
  { name: 'swarm',       group: 'Build',   usage: '!swarm <task>',     desc: 'Multi-agent swarm (council/consensus) on a task' },
  { name: 'radio',       group: 'Explore', usage: '!radio',            desc: 'Summon Radio inline (also: “play fallout radio”)', aliases: ['play'] },
  { name: 'videos',      group: 'Explore', usage: '!videos',           desc: 'Fresh videos feed', aliases: ['watch'] },
  { name: 'discover',    group: 'Explore', usage: '!discover',         desc: 'Discover reads/news feed', aliases: ['news', 'reads', 'feed'] },
  { name: 'build',       group: 'Explore', usage: '!build',            desc: 'Repo build activity (releases + commits)', aliases: ['github', 'releases', 'commits'] },
  { name: 'support',     group: 'Explore', usage: '!support',          desc: 'Patreon support tiers', aliases: ['patreon', 'tiers', 'donate'] },
];
function commandMatches(token) {
  const t = String(token || '').toLowerCase();
  return COMMANDS.filter(c => c.name.startsWith(t) || (c.aliases || []).some(a => a.startsWith(t)));
}
function findCommand(token) {
  const t = String(token || '').toLowerCase();
  return COMMANDS.find(c => c.name === t || (c.aliases || []).includes(t)) || null;
}

// ── !help and !issues renderers (command palette wires these too) ──────────────
function renderHelp() {
  hideEmptyState();
  const messages = document.getElementById('messages');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const groups = {};
  COMMANDS.forEach(c => { (groups[c.group] = groups[c.group] || []).push(c); });
  const sections = Object.keys(groups).map(g => {
    const rows = groups[g].map(c =>
      `<div style="display:flex;gap:10px;padding:3px 0;align-items:baseline">
         <code style="color:var(--accent);min-width:150px;font-size:12.5px">${esc(c.usage)}</code>
         <span style="font-size:12.5px;opacity:0.85">${esc(c.desc)}</span>
       </div>`).join('');
    return `<div style="margin-top:8px"><div style="font-weight:700;font-size:11px;text-transform:uppercase;opacity:0.5;letter-spacing:0.04em">${esc(g)}</div>${rows}</div>`;
  }).join('');
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px"><b>Commands</b> · type <code>!</code> or <code>/</code> in the box for autocomplete${sections}</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();
}
async function renderIssues() {
  hideEmptyState();
  const base = (typeof serverBase !== 'undefined') ? serverBase : window.location.origin;
  const messages = document.getElementById('messages');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Loading open issues…</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();
  const bubble = row.querySelector('.bubble');
  const ghLink = '<a href="https://github.com/alex-place/lantern-os/issues" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Open on GitHub →</a>';
  try {
    const r = await fetch(`${base}/api/dream/issues?limit=20`, { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok || !Array.isArray(d.issues) || !d.issues.length) {
      bubble.innerHTML = `No open issues to show${d && d.error ? ` (${esc(d.error)})` : ''}. ${ghLink}`;
      return;
    }
    const rows = d.issues.map(i => {
      const labels = (i.labels || []).slice(0, 3).map(l =>
        `<span style="font-size:10px;background:var(--surface2);padding:1px 6px;border-radius:8px;opacity:0.8">${esc(l)}</span>`).join(' ');
      return `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--border)">
        <a href="https://github.com/alex-place/lantern-os/issues/${i.number}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:600;font-size:12px;text-decoration:none">#${i.number}</a>
        <span style="flex:1;font-size:12.5px">${esc(i.title)} ${labels}</span>
        <button class="aw-work-btn" data-issue="${i.number}" style="font-size:11px;padding:3px 10px;border:1px solid var(--accent);border-radius:6px;background:transparent;color:var(--accent);cursor:pointer;white-space:nowrap">Work this →</button>
      </div>`;
    }).join('');
    bubble.innerHTML = `<b>Open issues</b> · ${d.issues.length} · ${ghLink}${rows}`;
    bubble.querySelectorAll('.aw-work-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.getAttribute('data-issue'), 10);
        btn.disabled = true; btn.textContent = 'Working…'; btn.style.opacity = '0.6';
        runAutowork(n, btn, base).catch(e => console.error('[autowork]', e));
      });
    });
  } catch (e) {
    bubble.innerHTML = `Couldn’t load issues (${esc(e.message)}). ${ghLink}`;
  }
}

// ── Open-PR browser (!prs / "review pull requests") ───────────────────────────
// PR analogue of renderIssues: lists the open PRs with a one-click "Review →" that
// runs the existing !review #N flow. Listing is a plain gh call (no LLM), so this
// works even when every provider is down — which is exactly the dead-end this fixes:
// a plural "review pull requests" used to fall through to the AI-unavailable fallback.
async function renderPRs() {
  hideEmptyState();
  const base = (typeof serverBase !== 'undefined') ? serverBase : window.location.origin;
  const messages = document.getElementById('messages');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Loading open pull requests…</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();
  const bubble = row.querySelector('.bubble');
  const ghLink = '<a href="https://github.com/alex-place/lantern-os/pulls" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Open on GitHub →</a>';
  try {
    const r = await fetch(`${base}/api/dream/prs?limit=20`, { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok || !Array.isArray(d.prs) || !d.prs.length) {
      bubble.innerHTML = `No open pull requests to show${d && d.error ? ` (${esc(d.error)})` : ''}. ${ghLink}`;
      return;
    }
    const rows = d.prs.map(p => {
      const draft = p.isDraft
        ? `<span style="font-size:10px;background:var(--surface2);padding:1px 6px;border-radius:8px;opacity:0.8">draft</span>` : '';
      return `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--border)">
        <a href="https://github.com/alex-place/lantern-os/pull/${p.number}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:600;font-size:12px;text-decoration:none">#${p.number}</a>
        <span style="flex:1;font-size:12.5px">${esc(p.title)} ${draft}</span>
        <button class="pr-review-btn" data-pr="${p.number}" style="font-size:11px;padding:3px 10px;border:1px solid var(--accent);border-radius:6px;background:transparent;color:var(--accent);cursor:pointer;white-space:nowrap">Review →</button>
      </div>`;
    }).join('');
    bubble.innerHTML = `<b>Open pull requests</b> · ${d.prs.length} · ${ghLink}${rows}`;
    bubble.querySelectorAll('.pr-review-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.getAttribute('data-pr'), 10);
        fillAndSend('!review #' + n);   // reuse the server-side !review #N reviewer
      });
    });
  } catch (e) {
    bubble.innerHTML = `Couldn’t load pull requests (${esc(e.message)}). ${ghLink}`;
  }
}

// ── Natural-language PR review intent ─────────────────────────────────────────
// "review pull requests" / "review prs" / "!prs" → list open PRs (the deterministic,
// provider-free browser above). "review pr #1410" / "review #1410" → route to the
// server's !review #N reviewer. Returns { kind:'list' } | { kind:'one', number } | null.
// Deliberately narrow so it never hijacks an ordinary turn — "review my essay" stays an
// LLM chat. !review #N (with a number) is left to the server handler (returns null).
function detectPrReviewIntent(text) {
  const t = String(text || '').trim();
  // Bang/slash forms. `!review #N` is left to the server reviewer (return null → fall through).
  let m = t.match(/^[!/](review|prs?|pull[\s-]?requests?|review[\s-]?prs?)\b\s*#?(\d+)?\s*$/i);
  if (m) {
    if (m[2]) return /^review$/i.test(m[1]) ? null : { kind: 'one', number: parseInt(m[2], 10) };
    return { kind: 'list' };
  }
  // "review pr #1410" / "review pull request 1410" / "review #1410"
  m = t.match(/^review\s+(?:the\s+)?(?:pull\s*request|pr)\s*#?(\d+)\s*$/i)
   || t.match(/^review\s+#(\d+)\s*$/i);
  if (m) return { kind: 'one', number: parseInt(m[1], 10) };
  // "review pull requests" / "review the open prs" / "list/show/browse open pull requests"
  m = t.match(/^(?:review|list|show|browse|see|view|check|open)\s+(?:(?:the|all|my|open|any)\s+)*(?:pull\s*requests?|prs?)\s*\??$/i);
  if (m) return { kind: 'list' };
  return null;
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
  ].join('\n');
  document.head.appendChild(st);
}

// In-chat review actions for an autowork draft PR (#1503): Approve (mark ready +
// squash-merge), Rework (re-run autowork on the same issue), Discard (close + delete
// branch). Approve/Discard hit POST /api/convergence/pr-action behind a confirm;
// Rework just re-invokes runAutowork. No-op when there's no PR to act on.
function renderAutoworkActions(fin, prUrl, issue, btn, base) {
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
  const approve = mk('✓ Approve', 'Mark ready for review & squash-merge', '#4ade80');
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
  approve.onclick = () => doAction('approve', `Approve and squash-merge this PR?\n\n${prUrl}`);
  discard.onclick = () => doAction('discard', `Discard (close) this PR and delete its branch?\n\n${prUrl}`);
  rework.onclick = () => {
    if (!window.confirm(`Re-run autowork on issue #${issue}? This supersedes the current attempt.`)) return;
    if (typeof runAutowork === 'function' && btn) runAutowork(parseInt(issue, 10) || issue, btn, base).catch(e => console.error('[autowork rework]', e));
  };
  all.forEach(b => bar.appendChild(b));
  fin.appendChild(bar);
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
  const stepRowsHtml = phases.map(([k, label, desc]) =>
    `<div class="aw-step" data-phase="${k}"><div class="aw-ico">○</div><div class="aw-body">`
    + `<div class="aw-row1"><span class="aw-label">${esc(label)}</span><span class="aw-desc">${esc(desc)}</span><span class="aw-extra"></span></div>`
    + `<div class="aw-detail" style="display:none"></div></div></div>`).join('');
  // Activity line = a live, streamed-feel header: the mandala spins while a step runs
  // and the text names what's happening right now (addresses "shows little/no info").
  row.innerHTML =
    `<div class="msg-label">Keystone · Autowork ${esc(panelLabel)}</div>`
    + `<div class="bubble aw-panel">`
    + `<div class="aw-activity"><img src="/mandala.svg" class="aw-spin" alt=""><div class="aw-act-text"><b>Starting autowork…</b> <span>${esc(taskMode ? 'filing the task as an issue' : 'on issue ' + panelLabel)}</span></div></div>`
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
      if (evName === 'run') { awRunId = d.runId; return; }
      if (evName === 'step') {
        let extra = '';
        if (d.phase === 'tests' && d.status === 'done') extra = d.passed ? 'passed' : (d.ran ? 'failed' : 'none');
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
      btn.textContent = '✓ Done';
      btn.style.color = '#4ade80';
      fin.style.color = '#4ade80';
      fin.innerHTML = finalDone.prUrl
        ? `✓ Auto-worked #${esc(finalDone.issue || issue)} — <a href="${esc(finalDone.prUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">View PR</a>`
        : `✓ ${esc(finalDone.message || 'Done')}`;
      renderAutoworkActions(fin, finalDone.prUrl, finalDone.issue || issue, btn, base);
      setActivity('Complete', finalDone.prUrl ? 'opened a pull request' : 'autonomous work finished', false);
      if (actImg) actImg.src = '/mandala.svg'; // steady (no spin)
    } else {
      btn.textContent = '✗ Failed';
      btn.style.color = '#f87171';
      if (!fin.textContent) {
        fin.style.color = '#f87171';
        fin.textContent = `✗ ${esc((finalDone && finalDone.message) || 'Auto-work failed')}`;
      }
      setActivity('Stopped', (finalDone && finalDone.message) || 'see the failed step above', false);
    }
    if (typeof scrollToBottom === 'function') scrollToBottom();
  } catch (e) {
    btn.textContent = '✗ Error';
    btn.style.color = '#f87171';
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
            renderAutoworkActions(fin, s.prUrl, (s.message && s.message.match(/#(\d+)/) ? RegExp.$1 : issue), btn, base);
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

// ── Image requests ─────────────────────────────────────────────────────────────
// Detect when the user is asking for a picture and return the subject prompt, else
// null. Two forms: explicit (!image / /image <prompt>) and natural language
// ("draw me a picture of X", "show me an image of X"). The natural form requires an
// image noun (picture/image/photo/…) so ordinary requests ("show me the status")
// don't trigger it.
function parseImageRequest(text) {
  const explicit = text.match(/^[!/]image\s+(.+)/i);
  if (explicit) return explicit[1].trim();
  const nl = text.match(/\b(?:draw|paint|sketch|generate|create|make|render|show|find|get|give)\b[^.?!]*?\b(?:image|picture|photo|drawing|illustration|art|painting)\b\s*(?:of|showing|with|featuring|:)?\s*(.+)/i);
  if (nl && nl[1] && nl[1].trim().length >= 2) return nl[1].trim().replace(/[.?!]+$/, '');
  return null;
}

// True when the user wants a REAL photo of a specific subject ("find/show me a photo
// of X") rather than an AI illustration ("draw/paint X"). Drives whether we try a real
// image search (Wikimedia Commons) before the generate chain (#1343). The "draw/paint/
// sketch/generate/create/render" verbs mean generate and take priority if both appear.
function imageWantsRealPhoto(text) {
  if (/^[!/]image\b/i.test(text)) return false; // explicit command → generate
  if (/\b(?:draw|paint|sketch|generate|create|render|illustrate)\b/i.test(text)) return false;
  return /\b(?:find|show|get|give|search|look\s+up|fetch)\b[^.?!]*?\b(?:image|picture|photo|pic|photograph)\b/i.test(text);
}

// Render a generated image for `prompt`. Tries OpenAI (DALL·E / gpt-image-1) FIRST via the
// server (the key stays server-side; the saved image serves from /images/… so it dodges local
// TLS interception). On any failure — no key, billing limit, content refusal, timeout — it
// falls back to a keyless text-to-image source (Pollinations) and then real photos (LoremFlickr),
// loaded directly by the browser, so an image still appears.
function renderWebImage(prompt, wantRealPhoto) {
  const messages = document.getElementById('messages');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">${wantRealPhoto ? 'Searching for a photo of' : 'Generating an image of'} <b>${esc(prompt)}</b>…</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();
  const bubble = row.querySelector('.bubble');

  const show = (url, label, sourceNote) => {
    const img = new Image();
    img.onload = () => {
      bubble.innerHTML = label;
      img.style.cssText = 'max-width:100%;border-radius:8px;margin:6px 0;display:block';
      img.alt = prompt;
      bubble.appendChild(img);
      if (typeof scrollToBottom === 'function') scrollToBottom();
      persistToolTurn('lantern', `Image of "${prompt}"${sourceNote ? ` (${sourceNote})` : ''}: ${url}`, { agent: 'Keystone', provider: 'image-tool', model: sourceNote || 'openai', tool: { kind: 'image', url, prompt, label, note: sourceNote || '' } });
    };
    img.onerror = () => keylessFallback();   // local/openai image failed to load → keyless
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  };

  // Keyless fallback: Pollinations (text-to-image, AI-generated) then LoremFlickr (a real
  // stock photo someone took — found, not generated). The label always names which one
  // actually loaded, so "generated" vs "found" is never ambiguous to the user (#1268).
  function keylessFallback() {
    const seed = Math.floor(Math.random() * 1e6);
    const keywords = encodeURIComponent(prompt.split(/\s+/).slice(0, 3).join(','));
    const sources = [
      { url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=768&height=512&nologo=true&seed=${seed}`,
        label: `Here's an AI-generated image of <b>${esc(prompt)}</b> <span style="opacity:.55;font-size:11px">· generated via Pollinations</span>:`,
        note: 'generated via Pollinations' },
      { url: `https://loremflickr.com/768/512/${keywords}?lock=${seed}`,
        label: `Couldn't generate an image, so here's a real stock photo matching <b>${esc(prompt)}</b> <span style="opacity:.55;font-size:11px">· found via LoremFlickr, not AI-generated</span>:`,
        note: 'found via LoremFlickr, not AI-generated' },
    ];
    let i = 0;
    (function tryNext() {
      if (i >= sources.length) {
        bubble.innerHTML = `Sorry — couldn't reach an image service for <b>${esc(prompt)}</b> right now. Please try again.`;
        if (typeof scrollToBottom === 'function') scrollToBottom();
        persistToolTurn('lantern', `Couldn't find or generate an image for "${prompt}" — no image service reachable.`, { agent: 'Keystone', provider: 'image-tool' });
        return;
      }
      const { url, label, note } = sources[i++];
      const img = new Image();
      let settled = false;
      const to = setTimeout(() => { if (!settled) { settled = true; img.onload = img.onerror = null; tryNext(); } }, 15000);
      img.onload = () => {
        if (settled) return;
        settled = true; clearTimeout(to);
        bubble.innerHTML = label;
        img.style.cssText = 'max-width:100%;border-radius:8px;margin:6px 0;display:block';
        img.alt = prompt;
        bubble.appendChild(img);
        if (typeof scrollToBottom === 'function') scrollToBottom();
        persistToolTurn('lantern', `Image of "${prompt}" (${note}): ${url}`, { agent: 'Keystone', provider: 'image-tool', model: note, tool: { kind: 'image', url, prompt, label, note } });
      };
      img.onerror = () => { if (!settled) { settled = true; clearTimeout(to); tryNext(); } };
      img.referrerPolicy = 'no-referrer';
      img.src = url;
    })();
  }

  // Real-photo intent (#1343): try a real image search (Wikimedia Commons, keyless) for
  // a specific subject BEFORE generating. If it finds an actual photo, show that and stop;
  // otherwise fall through to the generate chain so an image still appears.
  if (wantRealPhoto) {
    fetch('/api/image-search?q=' + encodeURIComponent(prompt))
      .then(r => r.json())
      .then(d => {
        if (d && d.url) {
          show(d.url,
            `Here's a real photo of <b>${esc(prompt)}</b> <span style="opacity:.55;font-size:11px">· found via ${esc(d.source || 'web search')}, not AI-generated</span>:`,
            `found via ${d.source || 'web search'}`);
        } else {
          generateChain();
        }
      })
      .catch(() => generateChain());
    return;
  }
  generateChain();

  // OpenAI first (server-side). 80s budget; on timeout/failure, fall back to keyless.
  function generateChain() {
  let done = false;
  const to = setTimeout(() => { if (!done) { done = true; keylessFallback(); } }, 80000);
  fetch('/api/image/ai-generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
    .then(r => r.json())
    .then(d => {
      if (done) return; done = true; clearTimeout(to);
      if (d && d.ok && d.url) show(d.url, `Here's an image of <b>${esc(prompt)}</b> <span style="opacity:.55;font-size:11px">· ${esc(d.model || 'openai')}</span>:`, `generated via ${d.model || 'openai'}`);
      else keylessFallback();
    })
    .catch(() => { if (!done) { done = true; clearTimeout(to); keylessFallback(); } });
  }
}

// Vision: send an uploaded image to a vision model (Claude / GPT-4o, server-side) and render
// the answer. Used when the user attaches an image via "+" and asks about it.
function renderVisionAnswer(prompt, attachment) {
  const messages = document.getElementById('messages');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Looking at <b>${esc(attachment.name)}</b>…</div>`;
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
        persistToolTurn('lantern', d.text, { agent: 'Keystone', provider: 'vision', model: d.model || 'vision' });
      } else {
        const errMsg = `Couldn't analyze ${attachment.name}: ${(d && d.error) || 'vision unavailable'}`;
        bubble.innerHTML = `Couldn't analyze <b>${esc(attachment.name)}</b>: ${esc((d && d.error) || 'vision unavailable')}`;
        persistToolTurn('lantern', errMsg, { agent: 'Keystone', provider: 'vision' });
      }
      if (typeof scrollToBottom === 'function') scrollToBottom();
    })
    .catch(e => { bubble.innerHTML = `Vision error: ${esc(e.message)}`; if (typeof scrollToBottom === 'function') scrollToBottom(); persistToolTurn('lantern', `Vision error analyzing ${attachment.name}: ${e.message}`, { agent: 'Keystone', provider: 'vision' }); });
}

// ── Document generation ──────────────────────────────────────────────────────────
// Detect a request to produce a document and return {prompt, format}, else null. Forms:
// explicit (!doc / !pdf / !docx / !deck <prompt>) and natural language ("make me a
// Word doc / spreadsheet / deck about X"). Requires a document noun so ordinary asks
// don't trigger it. Format inferred from the noun: word→docx, excel→xlsx, deck→pptx.
function docFormatOf(noun) {
  const n = String(noun).toLowerCase();
  if (/docx|word/.test(n)) return 'docx';
  if (/xlsx|excel|spread\s?sheet|workbook/.test(n)) return 'xlsx';
  if (/pptx|power\s?point|slide|deck|presentation/.test(n)) return 'pptx';
  return 'pdf';
}
// One alternation of document nouns, ordered specific→general so the format is inferable.
var DOC_NOUNS = 'docx|word\\s?document|word\\s?doc|word\\s?file|word(?!s)|xlsx|spread\\s?sheet|excel|workbook|pptx|power\\s?point|slide\\s?deck|slide\\s?show|slides?|deck|presentation|pdf|document|report|brief|memo|white\\s?paper|one[- ]?pager|write[- ]?up';
// Coding-intent markers: if present, an incidental "pdf/report/document" mention is
// part of a code task ("write a function that generates a pdf report") and must NOT
// be hijacked into document generation (#1274).
var CODING_INTENT_RE = /\b(function|method|class|code|script|program|module|library|package|api|endpoint|route|component|app(?:lication)?|repo(?:sitory)?|bug|refactor|debug|compile|unit test|test case|algorithm|variable|parameter|return|import|export|css|html|sql|query|regex|json|yaml)\b/i;

function parseDocRequest(text) {
  const explicit = text.match(new RegExp('^[!/](' + DOC_NOUNS + '|doc)\\s+(.+)', 'i'));
  if (explicit) return { prompt: explicit[2].trim(), format: docFormatOf(explicit[1]) };
  // A genuine document request leads with the verb (optionally behind a polite prefix),
  // not buried mid-sentence, and doesn't read as a coding task.
  if (CODING_INTENT_RE.test(text)) return null;
  const nl = text.match(new RegExp('^(?:please\\s+|can\\s+you\\s+|could\\s+you\\s+|i\\s+(?:need|want)\\s+(?:you\\s+to\\s+|a\\s+)?)?(?:make|create|generate|write|draft|build|produce|prepare)\\b[^.?!]*?\\b(' + DOC_NOUNS + ')\\b\\s*(?:about|on|for|covering|titled|of|:)?\\s*(.+)', 'i'));
  if (nl && nl[2] && nl[2].trim().length >= 3) return { prompt: nl[2].trim().replace(/[.?!]+$/, ''), format: docFormatOf(nl[1]) };
  return null;
}

// Generate a document via the server (model writes it → Markdown → PDF) and show a download link.
function renderDocGen(prompt, format) {
  const messages = document.getElementById('messages');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Writing &amp; rendering a document about <b>${esc(prompt)}</b>… (this takes a few seconds)</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();
  const bubble = row.querySelector('.bubble');
  fetch('/api/document/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, format: format || 'pdf' }),
  })
    .then(r => r.json())
    .then(d => {
      if (d && d.ok && d.url) {
        const kb = d.bytes ? ' · ' + Math.round(d.bytes / 1024) + ' KB' : '';
        bubble.innerHTML = `✓ Generated <b>${esc(d.title || 'document')}</b> <span style="opacity:.6;font-size:11px">(${esc(d.format)}${kb})</span><br>`
          + `<a href="${esc(d.url)}" download="${esc(d.filename)}" style="display:inline-block;margin-top:6px;padding:6px 12px;border:1px solid var(--accent,#06b6d4);border-radius:8px;color:var(--accent,#06b6d4);text-decoration:none;font-weight:600">⬇ Download ${esc(d.filename)}</a>`;
        persistToolTurn('lantern', `Generated document "${d.title || 'document'}" (${d.format}${kb}): ${d.url}`, { agent: 'Keystone', provider: 'document-generator', model: d.format, tool: { kind: 'document', url: d.url, title: d.title || 'document', filename: d.filename, format: d.format, bytes: d.bytes } });
      } else {
        bubble.innerHTML = `Couldn't generate the document: ${esc((d && d.error) || 'unavailable')}`;
        persistToolTurn('lantern', `Couldn't generate the document for "${prompt}": ${(d && d.error) || 'unavailable'}`, { agent: 'Keystone', provider: 'document-generator' });
      }
      if (typeof scrollToBottom === 'function') scrollToBottom();
    })
    .catch(e => { bubble.innerHTML = `Document error: ${esc(e.message)}`; if (typeof scrollToBottom === 'function') scrollToBottom(); persistToolTurn('lantern', `Document generation error for "${prompt}": ${e.message}`, { agent: 'Keystone', provider: 'document-generator' }); });
}

// ── Video requests ──────────────────────────────────────────────────────────────
// Detect a request to see a video and return the search query, else null. Forms:
// explicit (!video / /video <query>) and natural language ("show me a youtube video
// of X", "play a video of X"). Requires a video noun so it doesn't catch image asks.
function parseVideoRequest(text) {
  const explicit = text.match(/^[!/]video\s+(.+)/i);
  if (explicit) return explicit[1].trim();
  const nl = text.match(/\b(?:show|find|play|watch|get)\b[^.?!]*?\b(?:video|youtube|clip|footage)\b\s*(?:of|about|showing|for|on|:)?\s*(.+)/i);
  if (nl && nl[1] && nl[1].trim().length >= 2) {
    // Strip leftover leading filler when nouns stack ("youtube video of a flamingo").
    const q = nl[1].trim().replace(/[.?!]+$/, '')
      .replace(/^(?:(?:youtube|video|clip|footage|of|for|about|a|an|the|me|us|some)\s+)+/i, '')
      .trim();
    if (q.length >= 2) return q;
  }
  return null;
}

// Render a YouTube result for `query`. The browser embeds via an <iframe> (no CORS),
// using YouTube's keyless search embed; a guaranteed "Open on YouTube" link is always
// shown as a fallback in case the inline player is unavailable.
function renderYoutube(query) {
  const messages = document.getElementById('messages');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const q = encodeURIComponent(query);
  const embed = `https://www.youtube-nocookie.com/embed?listType=search&list=${q}`;
  const searchUrl = `https://www.youtube.com/results?search_query=${q}`;
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML =
    `<div class="msg-label">Keystone</div>` +
    `<div class="bubble" style="font-size:13px">Here are videos for <b>${esc(query)}</b>:` +
    `<iframe src="${embed}" width="100%" height="240" style="border:0;border-radius:8px;margin:6px 0;max-width:480px;display:block" ` +
    `allow="encrypted-media;picture-in-picture" allowfullscreen loading="lazy"></iframe>` +
    `<a href="${searchUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline">▶ Open these results on YouTube ↗</a></div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();
  persistToolTurn('lantern', `YouTube results for "${query}": ${searchUrl}`, { agent: 'Keystone', provider: 'youtube-search', tool: { kind: 'youtube', query, url: searchUrl } });
}

// ── Explore embed helpers ─────────────────────────────────────────────────────
const embedBase = () => window.location.origin;
function embedEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function embedShortDate(d) {
  if (!d) return '';
  const t = Date.parse(d);
  if (Number.isNaN(t)) return '';
  try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; }
}
async function embedVideos(base) {
  const r = await fetch(`${base}/api/youtube/lantern-videos`, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const vids = (d.videos || []).slice(0, 6);
  const featured = vids.find(v => v.featured || v.id === d.featured) || vids[0];
  if (!featured) throw new Error('no videos returned');
  const thumbs = vids.map(v =>
    `<a href="https://www.youtube.com/watch?v=${embedEsc(v.id)}" target="_blank" rel="noopener noreferrer" style="flex:0 0 auto;width:118px;text-decoration:none;color:inherit">
       <img src="https://img.youtube.com/vi/${embedEsc(v.id)}/mqdefault.jpg" alt="" loading="lazy" style="width:118px;height:66px;object-fit:cover;border-radius:6px;border:1px solid var(--border)">
       <div style="font-size:10.5px;line-height:1.3;margin-top:3px;max-height:27px;overflow:hidden">${embedEsc((v.title || '').slice(0, 42))}</div>
     </a>`).join('');
  return `<div style="font-weight:600;margin-bottom:6px">🎬 lanternYT</div>
    <iframe src="https://www.youtube-nocookie.com/embed/${embedEsc(featured.id)}?rel=0" width="100%" height="220" style="border:0;border-radius:8px;max-width:420px;display:block" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>
    <div style="display:flex;gap:8px;overflow-x:auto;padding:8px 0 2px">${thumbs}</div>`;
}
async function embedDiscover(base) {
  const r = await fetch(`${base}/api/feeds/discover`, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const items = (d.items || []).slice(0, 6);
  if (!items.length) throw new Error('no items returned');
  const rows = items.map(it => {
    const ext = /^https?:/i.test(it.link);
    const meta = [
      it.source ? `<span style="color:var(--accent);font-weight:600">${embedEsc(it.source)}</span>` : '',
      embedShortDate(it.date) ? `<span style="opacity:0.6">${embedEsc(embedShortDate(it.date))}</span>` : '',
    ].filter(Boolean).join(' · ');
    return `<div style="padding:6px 0;border-top:1px solid var(--border)">
      <a href="${embedEsc(it.link)}" ${ext ? 'target="_blank" rel="noopener noreferrer"' : ''} style="color:inherit;text-decoration:none;font-weight:600;font-size:12.5px">${embedEsc(it.title)}</a>
      ${meta ? `<div style="font-size:11px;margin-top:2px">${meta}</div>` : ''}
    </div>`;
  }).join('');
  return `<div style="font-weight:600;margin:12px 0 2px">🧭 Discover — fresh reads</div>${rows}`;
}
async function embedBuild(base) {
  const r = await fetch(`${base}/api/github/activity`, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const rel = (d.releases || [])[0];
  const commits = (d.commits || []).slice(0, 4);
  const stars = typeof d.stars === 'number' ? `★ ${d.stars}` : '';
  const tagPill = (txt, href) =>
    `<a href="${embedEsc(href)}" target="_blank" rel="noopener noreferrer" style="font-family:ui-monospace,monospace;background:var(--bg,#111);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--accent);text-decoration:none">${embedEsc(txt)}</a>`;
  const relHtml = rel ? `<div style="margin-top:4px;font-size:12px">${tagPill(rel.tag, rel.url)} ${embedEsc(rel.name || '')}</div>` : '';
  const comHtml = commits.map(c =>
    `<div style="padding:4px 0;font-size:12px">${tagPill(c.sha, c.url)} ${embedEsc((c.msg || '').slice(0, 74))}</div>`).join('');
  const repo = d.repo || 'alex-place/lantern-os';
  const url = d.url || 'https://github.com/alex-place/lantern-os';
  return `<div style="font-weight:600;margin:12px 0 2px">🛠️ Build — <a href="${embedEsc(url)}" target="_blank" rel="noopener noreferrer" style="color:inherit">${embedEsc(repo)}</a> <span style="opacity:0.6;font-weight:400">${stars}</span></div>${relHtml}<div style="margin-top:6px">${comHtml}</div>`;
}
function embedSupport() {
  const tiers = [
    ['Wanderer', '$5', 'Supporter role'],
    ['Deep Dreamer', '$20', 'Deep Dreamer role'],
    ['Synthesasia Guild', '$200', 'Guild (admin) role'],
  ];
  const cards = tiers.map(([n, p, perk]) =>
    `<a href="https://www.patreon.com/c/lanterndreamjournal" target="_blank" rel="noopener noreferrer" style="flex:1 1 110px;text-align:center;padding:10px;border:1px solid var(--border);border-radius:8px;text-decoration:none;color:inherit">
       <div style="font-weight:700;font-size:12.5px">${n}</div>
       <div style="font-size:1.2rem;font-weight:800">${p}<span style="font-size:.7rem;opacity:.6">/mo</span></div>
       <div style="font-size:10.5px;opacity:.65">${perk}</div>
     </a>`).join('');
  return `<div style="font-weight:600;margin:12px 0 6px">♥ Support — <a href="https://www.patreon.com/c/lanterndreamjournal" target="_blank" rel="noopener noreferrer" style="color:inherit">Patreon</a></div><div style="display:flex;gap:8px;flex-wrap:wrap">${cards}</div>`;
}
async function renderExploreEmbed(kind, userText) {
  addUserBubble(userText);
  const messages = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  row.innerHTML = '<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Pulling that up…</div>';
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();
  const bubble = row.querySelector('.bubble');
  const base = embedBase();
  const want = k => kind === k || kind === 'all';
  const fail = (label, e) => {
    const m = (e && e.message) || String(e || 'error');
    const hint = /HTTP 404/.test(m) ? ' — route not deployed (restart the server / merge the PR)' : '';
    return `<div style="font-size:12px;opacity:0.65;margin:8px 0">⚠ ${label} unavailable (${embedEsc(m)})${hint}</div>`;
  };
  const parts = [];
  if (want('videos'))   { try { parts.push(await embedVideos(base)); }   catch (e) { parts.push(fail('Videos', e)); } }
  if (want('discover')) { try { parts.push(await embedDiscover(base)); } catch (e) { parts.push(fail('Discover', e)); } }
  if (want('build'))    { try { parts.push(await embedBuild(base)); }    catch (e) { parts.push(fail('Build', e)); } }
  if (want('support'))  { try { parts.push(embedSupport()); }            catch (e) { parts.push(fail('Support', e)); } }
  parts.push(`<div style="margin-top:10px;font-size:11px;opacity:0.6">See more on <a href="/explore.html" style="color:var(--accent)">Explore →</a></div>`);
  bubble.innerHTML = parts.filter(Boolean).join('');
  if (typeof scrollToBottom === 'function') scrollToBottom();
}

// ── Explore embed intent detection ───────────────────────────────────────────
function detectEmbedIntent(text) {
  const s = text.trim();
  const bang = s.match(/^!(videos?|watch|youtube|discover|news|reads?|feed|build|github|releases?|commits?|support|patreon|tiers?|donate|embeds?)\b/i);
  if (bang) {
    const b = bang[1].toLowerCase();
    if (/^(videos?|watch|youtube)$/.test(b)) return 'videos';
    if (/^(discover|news|reads?|feed)$/.test(b)) return 'discover';
    if (/^(build|github|releases?|commits?)$/.test(b)) return 'build';
    if (/^(support|patreon|tiers?|donate)$/.test(b)) return 'support';
    if (/^embeds?$/.test(b)) return 'all';
  }
  if (s.startsWith('!')) return null;
  const ask = /\b(show|see|view|give|got|have|where|what'?s?|which|how|latest|recent|any|list|pull up|display|open)\b/i.test(s);
  if (!ask) return null;
  if (/\byoutube\b/i.test(s) || /\b(latest|recent|your|the|lantern)\b[^?]*\bvideos?\b/i.test(s)) return 'videos';
  if (/\b(discover|fresh reads?|news feed|articles?|rss feed|reading list)\b/i.test(s) || /\bwhat'?s? new\b/i.test(s)) return 'discover';
  if (/\b(github|releases?|recent commits?|repo activity|build (status|activity))\b/i.test(s)) return 'build';
  if (/\b(patreon|membership|tiers?|how (can i|to) support|support the (project|work))\b/i.test(s)) return 'support';
  if (/\b(embeds?|explore (page |content |feeds?)|what can you (show|surface))\b/i.test(s)) return 'all';
  return null;
}

// ── On-demand Explore embeds (summon games / radio / films into chat) ─────────
// "play fallout radio", "play pac-man", "watch nosferatu" — summon any Explore
// embed straight into the conversation as a sandboxed iframe, no LLM cost. Same
// content source as the Explore feed (data/explore/embeds.json via
// /api/explore/embeds) and the same allowlist + sandbox as explore.html's player,
// so there's one catalog to maintain. Loop stage: Act (media/interaction is a
// first-class cockpit capability). See keystone-radio-feature / explore-embed-feed.

// An embed src may only be a root-relative path (our own /fallout-radio.html) or an
// https archive.org / github.io / youtube / vimeo URL — parity with explore.html's
// safeEmbedSrc. Anything else is never framed (defense vs a poisoned catalog row).
const CHAT_EMBED_HOSTS = /^https:\/\/(archive\.org|[a-z0-9-]+\.github\.io|www\.youtube(?:-nocookie)?\.com|player\.vimeo\.com)\//i;
function safeEmbedSrc(u) {
  const s = String(u || '');
  return (/^\/[^/]/.test(s) || CHAT_EMBED_HOSTS.test(s)) ? s : '';
}

// Launch verbs that signal "open this thing now". A single embed token (e.g. "radio")
// only summons when one of these is present; a multi-word name ("fallout radio") fires
// on its own. Keeps "I love the radio" from blasting audio at you.
const SUMMON_VERBS = /\b(play|summon|open|launch|start|run|boot|listen(?:\s+to)?|tune\s+(?:in|into|to)?|put\s+on|turn\s+on|fire\s+up|load|cue\s+up|watch|show(?:\s+me)?|pull\s+up|bring\s+up|display)\b/i;

// The flagship stays summonable even before /api/explore/embeds is deployed (a new
// route 404s on a stale server). kind: listen|game|watch drives the verb + icon.
const EMBED_SEED = [
  {
    slug: 'keystone-radio', title: 'Radio', kind: 'listen',
    src: '/fallout-radio.html', height: 620, source: 'Radio',
    url: '/fallout-radio.html',
    lore: 'A retro Pip-Boy tuner spinning public-domain 1940s radio — the songs that play at the end of the world. Press play; tune the dial.',
    aliases: ['fallout radio', 'keystone radio', 'pip-boy radio', 'radio'],
  },
  {
    // #1617: "show me the panels from the trade screen" used to send the local
    // tool-calling model into a read-the-HTML loop that dumped raw markup. Summoning
    // the real terminal inline frames the live panels instead.
    slug: 'kalshi-terminal', title: 'Kalshi Trade Terminal', kind: 'app',
    src: '/kalshi-terminal.html', height: 640, source: 'Keystone Trading',
    url: '/kalshi-terminal.html',
    lore: 'The live Kalshi trade screen — swipe-deck panels for decisive entries, open positions, and market signals.',
    aliases: ['trade screen', 'trade panels', 'trading terminal', 'kalshi terminal', 'trade deck', 'kalshi'],
  },
];

let _embedCatalog = null;    // hydrated [{slug,title,kind,src,height,_terms}]
let _embedCatalogP = null;   // in-flight hydrate promise

// Derive match phrases (≥2 words OK) + distinctive single tokens from an embed's
// slug, title, src filename, and curated aliases. A multi-word phrase is specific
// enough to fire on its own; a lone token needs a launch verb.
function embedSummonTerms(e) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const srcBase = norm((String(e.src || '').split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '')); // "/fallout-radio.html" → "fallout radio"
  const phrases = new Set();
  [norm(e.slug), norm(e.title), srcBase, ...(e.aliases || []).map(norm)].forEach(p => { if (p) phrases.add(p); });
  // Years / platform tags pollute titles ("Prince of Persia (1990)", "...usa nes") — never match on those.
  const STOP = new Set(['the','of','and','for','usa','japan','europe','rev','nes','snes','gb','gbc','n64','dos','msdos','arcade','game','play','listen','watch']);
  const tokens = new Set();
  // Drop real publish years (1900s–2019, which appear in titles like "(1990)") but
  // keep names that just look year-ish, e.g. the game "2048".
  phrases.forEach(p => p.split(' ').forEach(t => {
    if (t.length >= 4 && !STOP.has(t) && !/^(19\d\d|20[01]\d)$/.test(t)) tokens.add(t);
  }));
  (e.aliases || []).forEach(a => { const n = norm(a); if (n && !n.includes(' ') && n.length >= 3) tokens.add(n); }); // short single-word aliases ("2048")
  return { phrases: [...phrases].filter(p => p.length >= 3), tokens: [...tokens] };
}

// Pull the full catalog once (radio seed first so it always wins), enriching with
// games/films from the server. Best-effort: offline → seed only, radio still works.
function hydrateEmbedCatalog() {
  if (_embedCatalog) return Promise.resolve(_embedCatalog);
  if (_embedCatalogP) return _embedCatalogP;
  _embedCatalogP = (async () => {
    const list = EMBED_SEED.map(e => ({ ...e }));
    try {
      const r = await fetch(`${embedBase()}/api/explore/embeds`, { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        for (const row of (Array.isArray(d.embeds) ? d.embeds : [])) {
          const src = row && row.embed && row.embed.src;
          const slug = row && (row.slug || String(row.id || '').replace(/^embed:/, ''));
          if (!src || !slug || !safeEmbedSrc(src)) continue;
          if (list.some(e => e.slug === slug)) continue;          // seed (flagship) wins
          const topics = Array.isArray(row.topics) ? row.topics : [];
          const kind = topics.includes('listen') ? 'listen'
            : topics.some(t => t === 'watch' || t === 'film') ? 'watch' : 'game';
          list.push({
            slug, title: row.title || slug, kind, src,
            height: Number(row.embed.height) || 360,
            source: row.source || '', lore: row.lore || '', url: row.url || src, aliases: [],
          });
        }
      }
    } catch { /* offline → seed only */ }
    _embedCatalog = list.map(e => ({ ...e, _terms: embedSummonTerms(e) }));
    return _embedCatalog;
  })();
  return _embedCatalogP;
}

// Return the embed the user is asking to summon, or null. Synchronous against the
// hydrated catalog (kicked off at load); falls back to the seed so the radio always
// resolves even on the very first message.
function detectEmbedSummon(text) {
  const s = String(text || '').trim();
  if (!s || s[0] === '!' || s[0] === '/') return null;            // "!"/"/" commands handled elsewhere
  const flat = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = ' ' + flat + ' ';
  const hasVerb = SUMMON_VERBS.test(s);
  const catalog = _embedCatalog || EMBED_SEED.map(e => ({ ...e, _terms: embedSummonTerms(e) }));
  let best = null;
  const consider = (embed, len) => { if (!best || len > best.len) best = { embed, len }; };
  for (const e of catalog) {
    const terms = e._terms || embedSummonTerms(e);
    // (a) The whole message IS the name ("fallout radio", "pac man", "radio") → fire,
    //     no verb needed. Exact match wins big so it beats any in-sentence token match.
    for (const p of terms.phrases) { if (flat === p) consider(e, p.length + 1000); }
    // (b) A launch verb + a name (phrase or distinctive token) anywhere in the message
    //     ("play fallout radio", "put on the radio", "watch nosferatu"). Requiring the
    //     verb keeps "tell me about pac-man" / "i love the radio" from summoning.
    if (hasVerb) {
      for (const p of terms.phrases) { if (p.includes(' ') && norm.includes(' ' + p + ' ')) consider(e, p.length); }
      for (const t of terms.tokens) { if (norm.includes(' ' + t + ' ')) consider(e, t.length); }
    }
  }
  return best ? best.embed : null;
}

// Single active summoned embed — tearing down the previous one means two radios
// never play over each other when you summon again.
let activeChatEmbed = null;

// Frame an embed inline in the chat. Mirrors explore.html's player: safeEmbedSrc
// allowlist, the same sandbox attrs, a stop (unloads → silences) + fullscreen.
function renderChatEmbed(embed, userText) {
  addUserBubble(userText);
  persistToolTurn('operator', userText);
  const messages = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = 'msg-row agent';
  const src = safeEmbedSrc(embed.src);
  if (!src) {
    row.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Couldn't summon <b>${embedEsc(embed.title)}</b> — that embed isn't framable.</div>`;
    messages.appendChild(row);
    if (typeof scrollToBottom === 'function') scrollToBottom();
    return;
  }
  if (activeChatEmbed && activeChatEmbed.stop) { try { activeChatEmbed.stop(); } catch {} activeChatEmbed = null; }
  const icon = embed.kind === 'listen' ? '📻' : embed.kind === 'watch' ? '🎬' : embed.kind === 'app' ? '📊' : '🕹️';
  const verb = (embed.kind === 'watch' || embed.kind === 'app') ? 'Now showing' : 'Now playing';
  const h = Math.max(160, Math.min(640, Number(embed.height) || 360));
  row.innerHTML =
    `<div class="msg-label">Keystone</div>` +
    `<div class="bubble" style="font-size:13px">` +
      `<div class="chat-embed" style="border:1px solid var(--border,#2a2a3a);border-radius:10px;overflow:hidden;max-width:480px">` +
        `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(92,200,255,.10);color:var(--accent,#5cc8ff);font-weight:600;font-size:12.5px">` +
          `<span aria-hidden="true">${icon}</span><span style="flex:1">${verb} — ${embedEsc(embed.title)}</span>` +
          `<button type="button" class="ce-fs" title="Fullscreen" aria-label="Fullscreen" style="background:none;border:0;color:inherit;cursor:pointer;font-size:14px;line-height:1">⛶</button>` +
          `<button type="button" class="ce-stop" title="Stop" aria-label="Stop" style="background:none;border:0;color:inherit;cursor:pointer;font-size:14px;line-height:1">✕</button>` +
        `</div>` +
        `<div class="ce-frame">` +
          `<iframe src="${embedEsc(src)}" style="width:100%;height:${h}px;border:0;display:block" title="${embedEsc(embed.title)}" ` +
            `allow="autoplay; fullscreen; gamepad" referrerpolicy="no-referrer" ` +
            `sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-pointer-lock"></iframe>` +
        `</div>` +
        (embed.lore ? `<div style="padding:6px 10px;font-size:11px;opacity:0.6;border-top:1px solid var(--border,#2a2a3a)">${embedEsc(embed.lore)}</div>` : '') +
      `</div>` +
    `</div>`;
  messages.appendChild(row);
  if (typeof scrollToBottom === 'function') scrollToBottom();

  const frame = row.querySelector('.ce-frame');
  const iframe = row.querySelector('iframe');
  const stop = () => { if (frame) frame.innerHTML = `<div style="padding:16px 10px;font-size:12px;opacity:0.6">⏹ Stopped — summon it again to play.</div>`; };
  activeChatEmbed = { iframe, stop };
  const stopBtn = row.querySelector('.ce-stop');
  if (stopBtn) stopBtn.addEventListener('click', () => { stop(); if (activeChatEmbed && activeChatEmbed.iframe === iframe) activeChatEmbed = null; });
  const fsBtn = row.querySelector('.ce-fs');
  if (fsBtn) fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); return; }
    const node = row.querySelector('.ce-frame iframe') || row.querySelector('.ce-frame');
    const req = node && (node.requestFullscreen || node.webkitRequestFullscreen || node.msRequestFullscreen);
    if (req) { try { req.call(node); } catch {} }
  });
  try { iframe.focus(); } catch {}

  // Persist so a reload / session-switch restores the live embed (renderToolReplay 'embed').
  persistToolTurn('lantern', `${verb} — ${embed.title}: ${embed.url || src}`, {
    agent: 'Keystone', provider: 'explore-embed',
    tool: { kind: 'embed', src, title: embed.title, height: h, embedKind: embed.kind, lore: embed.lore || '', url: embed.url || src },
  });
}

// Warm the catalog at load so games/films resolve on the first message (the radio
// resolves from the seed regardless).
hydrateEmbedCatalog();

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
  // (gatedSendMessage in dream-chat.html + the !convergance shim in convergance-sync.js);
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
  // Slash-command parity: /work, /convergence, /issues … → canonical "!" form,
  // matching Claude Code's "/" convention. Only rewrites a leading "/<token>" when
  // <token> is a known command, so ordinary text starting with "/" is left alone.
  if (overrideText == null) {
    const _sm = String(input.value || '').match(/^\/([a-z][\w-]*)/i);
    if (_sm && findCommand(_sm[1])) input.value = '!' + input.value.slice(1);
  }
  // Normalize the legacy !convergance command → canonical !convergence.
  if (/^!convergance(?:\s+(?:sync|loop|run))?\s*$/i.test(String(input.value || "").trim())) input.value = "!convergence";
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

  // Image request → return a visible image from the web (deterministic, no LLM —
  // the desk model can't draw and just declines). Handles "draw me a picture of X"
  // and the explicit !image / /image <prompt> commands.
  const imagePrompt = parseImageRequest(text);
  if (imagePrompt) {
    input.value = '';
    input.style.height = 'auto';
    addUserBubble(text);
    persistToolTurn('operator', text);
    renderWebImage(imagePrompt, imageWantsRealPhoto(text));
    return;
  }

  // Video request → embed a YouTube search result + guaranteed link (deterministic,
  // no LLM — the desk model can't fetch external streams and just declines). Handles
  // "show me a youtube video of X" and the explicit !video / /video <query> commands.
  const videoQuery = parseVideoRequest(text);
  if (videoQuery) {
    input.value = '';
    input.style.height = 'auto';
    addUserBubble(text);
    persistToolTurn('operator', text);
    renderYoutube(videoQuery);
    return;
  }

  // Document request → generate a downloadable document (the model writes it, the server
  // renders Markdown → PDF). Handles "make me a PDF/report/brief about X" and !doc/!pdf <prompt>.
  const docReq = parseDocRequest(text);
  if (docReq) {
    input.value = '';
    input.style.height = 'auto';
    addUserBubble(text);
    persistToolTurn('operator', text);
    renderDocGen(docReq.prompt, docReq.format);
    return;
  }

  // !radio summons Radio; !play <name> summons any Explore embed by name.
  // (Slash forms /radio and /play work too — /radio normalizes via the command list.)
  const summonCmd = text.match(/^[!/](radio|play)\b\s*(.*)$/i);
  if (summonCmd) {
    input.value = '';
    input.style.height = 'auto';
    const arg = summonCmd[2].trim();
    const picked = arg ? detectEmbedSummon('play ' + arg)
                       : (_embedCatalog || EMBED_SEED)[0];   // bare !radio/!play → flagship radio
    if (picked) { renderChatEmbed(picked, text); return; }
    addUserBubble(text);
    const m = document.getElementById('messages');
    const r = document.createElement('div');
    r.className = 'msg-row agent';
    r.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Couldn't find an embed called <b>${embedEsc(arg)}</b>. Try “play fallout radio”, or browse <a href="/explore.html" style="color:var(--accent)">Explore →</a>.</div>`;
    m.appendChild(r);
    if (typeof scrollToBottom === 'function') scrollToBottom();
    return;
  }

  // Natural-language embed summon → frame a game / radio / film inline ("play fallout
  // radio", "play pac-man", "watch nosferatu"). Deterministic, no LLM. Runs AFTER
  // image/video/doc so a genuine "show me a video of X" still routes to YouTube.
  const summonEmbed = detectEmbedSummon(text);
  if (summonEmbed) {
    input.value = '';
    input.style.height = 'auto';
    renderChatEmbed(summonEmbed, text);
    return;
  }

  // !explore opens the Explore page (the Three-Doors game was removed 2026-06-26).
  if (/^!explore\b/i.test(text)) {
    input.value = '';
    window.location.href = '/explore.html';
    return;
  }

  // !convergence / !convergance — live repo status: agent fleet + csf-agent + version
  if (/^!converg(?:ence|ance)$/i.test(text)) {
    input.value = '';
    const base = (typeof serverBase !== 'undefined') ? serverBase : window.location.origin;
    const messages = document.getElementById('messages');
    addUserBubble(text);
    const sysRow = document.createElement('div');
    sysRow.className = 'msg-row agent';
    sysRow.innerHTML = '<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">Running convergence loop…</div>';
    messages.appendChild(sysRow);
    if (typeof scrollToBottom === 'function') scrollToBottom();
    const runLoop      = fetch(`${base}/api/actions/run-loop`, { method: 'POST' });
    const fetchVersion = fetch(`${base}/api/version`).then(r => r.ok ? r.json() : null).catch(() => null);
    const fetchAgents  = fetch(`${base}/api/dream/status/agents`).then(r => r.ok ? r.json() : null).catch(() => null);
    const fetchInspect = fetch(`${base}/api/actions/inspect`).then(r => r.ok ? r.json() : null).catch(() => null);
    Promise.all([runLoop, fetchVersion, fetchAgents, fetchInspect])
      .then(async ([loopR, versionD, agentD, inspectD]) => {
        const d = loopR.ok ? await loopR.json() : {};
        const rawOut = d.stdout || '';
        const tag    = versionD?.version?.semver || versionD?.version?.tag || '–';
        const commit = versionD?.version?.commit ? versionD.version.commit.slice(0, 7) : '?';
        let score = null, promo = null;
        try { const m = rawOut.match(/\{[\s\S]*"promotion_ready"[\s\S]*?\}/); if (m) { const j = JSON.parse(m[0]); score = j.convergence_score; promo = j.promotion_ready; } } catch {}
        const scoreStr = score != null ? ` · score ${(score * 100).toFixed(0)}%` : '';
        const promoStr = promo === true ? ' · ✓ ready' : promo === false ? ' · ✗ not ready' : '';
        const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const branch = versionD?.version?.branch;
        const branchStr = branch && branch !== 'unknown' ? ` · <code style="opacity:0.7">${esc(branch)}</code>` : '';
        const header = `<b>Convergence</b> ${loopR.ok ? '✓' : '✗'} · <code>${esc(tag)}</code> <code>${esc(commit)}</code>${branchStr}${scoreStr}${promoStr}`;
        const GH = 'https://github.com/alex-place/lantern-os';
        let agentBlock = '';
        if (agentD?.slots || agentD?.queue) {
          const q = agentD.queue || {};
          const lanes = (agentD.slots || []).map(s => `${s.lane.replace(/\/$/, '')} lane: ${s.status === 'working' ? '⚡ working' : s.enabled ? 'Ready' : 'Disabled'}`).join('\n');
          const qLine = `Queue: ${q.pending||0} pending · ${q.working||0} working · ${q.completed||0} done`;
          const nextLinks = (q.next || []).map(e => `  <a href="${GH}/issues/${e.number}" target="_blank" style="color:var(--accent)">#${e.number}</a> ${esc((e.title||'').slice(0,48))}`).join('\n');
          agentBlock = `<div style="margin-top:10px;padding:8px;background:var(--surface2,#1e1e2e);border-radius:6px;font-size:12px"><b>Agent Fleet</b><pre style="margin:4px 0 0;white-space:pre-wrap;color:var(--accent,#7c3aed);opacity:0.9">${esc(lanes)}\n${esc(qLine)}${nextLinks ? '\nNext up:\n' + nextLinks : ''}</pre></div>`;
        } else if (agentD?.text) {
          agentBlock = `<div style="margin-top:10px;padding:8px;background:var(--surface2,#1e1e2e);border-radius:6px;font-size:12px"><b>Agent Fleet</b><pre style="margin:4px 0 0;white-space:pre-wrap;color:var(--accent,#7c3aed);opacity:0.9">${esc(agentD.text)}</pre></div>`;
        }
        let csfBlock = '';
        const csf = inspectD?.csf_agent;
        if (csf?.pending_specs > 0) {
          csfBlock = `<div style="margin-top:8px;padding:8px;background:rgba(161,139,250,0.08);border-left:2px solid var(--accent);font-size:12px"><b>CSF Agent</b> · ${csf.pending_specs} spec${csf.pending_specs > 1 ? 's' : ''} awaiting review<br><span style="opacity:0.7">${(csf.specs || []).map(esc).join(', ')}</span></div>`;
        } else if (csf?.top_issue) {
          const ti = csf.top_issue;
          csfBlock = `<div style="margin-top:8px;padding:8px;background:rgba(6,182,212,0.06);border-left:2px solid var(--accent);font-size:12px"><b>Top Issue</b> · #${ti.number} <a href="${GH}/issues/${ti.number}" target="_blank" style="color:var(--accent)">${esc(ti.title)}</a><br><span style="opacity:0.6">score ${(ti.score * 100).toFixed(0)}%</span></div>`;
        }
        sysRow.querySelector('.bubble').innerHTML = header + agentBlock + csfBlock;
        if (typeof scrollToBottom === 'function') scrollToBottom();
      })
      .catch(e => { sysRow.querySelector('.bubble').textContent = `Convergence failed: ${e.message}`; });
    return;
  }

  // (!ask + work/status intents now flow through the single /api/dream/chat/stream
  // endpoint; the server short-circuits them to the convergence agent and streams the
  // answer + `actions`, rendered below from the done event. Stage 3 of the unification.)

  // !help / !commands — list every available command (Claude-Code-style)
  if (/^!(?:help|commands?)\b/i.test(text)) {
    input.value = '';
    addUserBubble(text);
    renderHelp();
    return;
  }

  // !issues / !backlog — browse the open backlog; each row has a "Work this →"
  // button that fires the existing autowork pipeline (issue → linked PR).
  if (/^!(?:issues?|backlog)\b/i.test(text)) {
    input.value = '';
    addUserBubble(text);
    renderIssues().catch(e => console.error('[issues]', e));
    return;
  }

  // !work / !edit <issue#> — observable autonomous workspace (Sigma-0, issue #527)
  const workMatch = text.match(/^!(?:work|edit)\s+#?(\d+)/i);
  if (workMatch) {
    input.value = '';
    addUserBubble(text);
    const base = (typeof serverBase !== 'undefined') ? serverBase : window.location.origin;
    // Dummy button so runAutowork can report status without a chip
    const dummyBtn = { textContent: '', style: {} };
    runAutowork(parseInt(workMatch[1], 10), dummyBtn, base).catch(err => console.error('[autowork]', err));
    return;
  }

  // PR review intent — "review pull requests" / "!prs" lists the open PRs (deterministic,
  // no LLM, works while every provider is down); "review pr #N" runs the !review reviewer.
  // Placed before the LLM path so the plural ask no longer dead-ends at "AI unavailable".
  const prIntent = detectPrReviewIntent(text);
  if (prIntent) {
    input.value = '';
    input.style.height = 'auto';
    if (prIntent.kind === 'one') { fillAndSend('!review #' + prIntent.number); return; }
    addUserBubble(text);
    renderPRs().catch(e => console.error('[prs]', e));
    return;
  }

  // Explore embeds — surface videos / discover feed / GitHub activity / Patreon
  // tiers inline when asked (bang commands or a "show/what/latest" NL framing).
  // Deterministic, no LLM cost; same server-cached routes as the Explore page.
  const embedKind = detectEmbedIntent(text);
  if (embedKind) {
    input.value = '';
    input.style.height = 'auto';
    renderExploreEmbed(embedKind, text).catch(e => console.error('[embed]', e));
    return;
  }

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

  bubble.innerHTML = renderMarkdown(fullText);

  // Convergence-agent action chips (Stage 3): the server streamed a deterministic
  // work/ask answer + actions through the one endpoint — render the chips here.
  if (doneActions) {
    renderActionChips(bubble, doneActions, (typeof serverBase !== 'undefined') ? serverBase : window.location.origin);
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

  if (bubble.dataset.sigma0Corrected) {
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
    } else {
      // AMBER (or red while offline): the honest passive badge. Unchanged from before the
      // active gate — internally consistent but unverified, surfaced to the user.
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
  if (bubble.dataset.councilVerdict) {
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

  // Signature line: always show a human-readable label + time. Raw provider/model id
  // goes in a collapsed <details> so curious users can inspect it without it cluttering
  // every reply for normal users. (#1141)
  if (!didError) {
    const sig = document.createElement('div');
    sig.className = 'msg-route-sig';
    const t = doneTimestamp ? new Date(doneTimestamp) : new Date();
    const time = isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // Human-readable label: "Keystone · chat" or the agent route label.
    const displayLabel = routeLabel || 'Keystone · chat';
    if (doneOnline === false) {
      // Offline path: make it explicit for the user.
      sig.textContent = `${displayLabel} · offline${time ? ' · ' + time : ''}`;
      sig.setAttribute('aria-label', `Keystone replied offline${time ? ' at ' + time : ''}`);
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
      if (pm) {
        // Wrap provider/model in a disclosure so it's accessible but not noisy.
        sig.innerHTML =
          `<span>${visibleText}${swapChip}</span>` +
          `<details class="sig-debug" style="display:inline-block;margin-left:6px">` +
          `<summary style="display:inline;cursor:pointer;font-size:10px;opacity:0.45;list-style:none" aria-label="Debug details">▸ debug</summary>` +
          `<span class="sig-debug-body" style="font-size:10px;opacity:0.55;margin-left:4px">${pm}${swapDebug}</span>` +
          `</details>`;
        sig.setAttribute('aria-label', `Keystone replied${time ? ' at ' + time : ''}; model: ${pm}` + (swapTitle ? `; ${swapTitle}` : ''));
      } else {
        sig.innerHTML = `<span>${visibleText}${swapChip}</span>`;
        sig.setAttribute('aria-label', `Keystone replied${time ? ' at ' + time : ''}` + (swapTitle ? `; ${swapTitle}` : ''));
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
  if (!didError && doneOnline !== false && CODING_INTENTS.includes(doneIntent) && !_looksLikeLookup) {
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

  if (!didError) history.push({ role: 'assistant', text: fullText });
}

// ── Auto-expand textarea ──────────────────────────────────────────────────────
document.getElementById('input').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
});

// ── Command palette (type ! or / for Claude-Code-style autocomplete) ───────────
// A floating menu over the composer that filters COMMANDS as you type a leading
// "!"/"/". Arrows to move, Enter/Tab to pick, Esc to dismiss. Only opens while the
// whole line is a bare command token (no space/args yet), so it never gets in the
// way of normal typing. Keydown is captured so it beats the inline Enter→send.
(function initCommandPalette() {
  const input = document.getElementById('input');
  if (!input) return;
  const menu = document.createElement('div');
  menu.id = 'cmd-palette';
  menu.setAttribute('role', 'listbox');
  menu.style.cssText = 'position:fixed;display:none;z-index:120;max-height:300px;overflow-y:auto;' +
    'background:var(--surface,#1a1a1a);border:1px solid var(--border,#333);border-radius:10px;' +
    'box-shadow:0 10px 30px rgba(0,0,0,0.45);padding:4px';
  document.body.appendChild(menu);
  let items = [];
  let active = 0;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  function close() { menu.style.display = 'none'; items = []; }
  function render() {
    if (!items.length) { close(); return; }
    if (active >= items.length) active = 0;
    menu.innerHTML = items.map((c, i) =>
      `<div class="cmd-row" data-i="${i}" role="option" aria-selected="${i === active}" style="display:flex;gap:10px;align-items:baseline;padding:7px 10px;border-radius:7px;cursor:pointer;${i === active ? 'background:var(--surface2,#2a2a2a)' : ''}">
         <code style="color:var(--accent);font-size:12.5px;min-width:130px">${esc(c.usage)}</code>
         <span style="font-size:12px;opacity:0.75">${esc(c.desc)}</span>
       </div>`).join('');
    const r = input.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.width = Math.max(300, r.width) + 'px';
    menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    menu.style.display = 'block';
    menu.querySelectorAll('.cmd-row').forEach(el => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(parseInt(el.getAttribute('data-i'), 10)); });
    });
  }
  function choose(i) {
    const c = items[i];
    if (!c) return;
    close();
    if (/[<#]/.test(c.usage)) {
      // Command takes an argument — prefill and let the user type it.
      input.value = '!' + c.name + ' ';
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // No-arg command — fire it immediately.
      input.value = '!' + c.name;
      if (typeof sendMessage === 'function') sendMessage();
    }
  }
  function update() {
    const m = String(input.value || '').match(/^[!\/]([a-z-]*)$/i);
    if (!m) { close(); return; }
    items = commandMatches(m[1]);
    active = 0;
    render();
  }
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (menu.style.display === 'none' || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }, true);
  input.addEventListener('blur', () => setTimeout(close, 120));
})();

// ── Handoff prefill (?seed=) ──────────────────────────────────────────────────
// Lets other surfaces (e.g. /orchestration.html) hand a task into Keystone chat.
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

// ── Provider selection handoff (?provider=) ─────────────────────────────────────
// Allows orchestration.html to route chat through a specific AI provider.
// Non-auto selections override the router's fallback chain for this session.
(function applyProviderSelection() {
  try {
    const provider = new URLSearchParams(location.search).get('provider');
    const select = document.getElementById('provider-select');
    if (provider && select) {
      // Try to set the selected provider
      if (select.querySelector(`option[value="${provider}"]`)) {
        select.value = provider;
        console.log(`[dream-chat] Provider set to: ${provider}`);
      } else if (provider !== 'auto') {
        // Provider not available; log but don't break
        console.warn(`[dream-chat] Requested provider '${provider}' not available, using router default`);
      }
      // Dispatch change event so any listeners update
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (e) { /* no-op */ }
})();

// ── Observer side panel ───────────────────────────────────────────────────────
function toggleObserver() {
  const panel = document.getElementById('observer-panel');
  const btn = document.getElementById('observer-toggle-btn');
  const collapsed = panel.classList.toggle('collapsed');
  if (btn) btn.classList.toggle('active', !collapsed);
  if (!collapsed) refreshObserver();
}

function refreshObserver() {
  fetch('/api/csf/stats').then(r => r.ok ? r.json() : null).then(data => {
    if (!data) return;
    const symList = document.getElementById('obs-symbols');
    if (data.top10 && data.top10.length > 0) {
      symList.innerHTML = data.top10.slice(0, 8).map(s =>
        `<span class="obs-symbol-chip${s.count >= 3 ? ' hot' : ''}">${s.token} ×${s.count}</span>`
      ).join('');
    } else { symList.textContent = 'none yet'; }
    document.getElementById('obs-dilation').textContent =
      data.delta_count ? `${data.delta_count} entries` : '—';
  }).catch(() => {});

  fetch('/api/csf/deltas?limit=5').then(r => r.ok ? r.json() : null).then(data => {
    if (!data || !data.length) return;
    const last = data[data.length - 1];
    const moods = data.filter(d => d.mood_abs != null).map(d => d.mood_abs);
    if (moods.length >= 2) {
      const first = moods[0], latest = moods[moods.length - 1];
      const diff = latest - first;
      const label = Math.abs(diff) < 0.1 ? 'stable' : diff > 0 ? '↑ rising' : '↓ falling';
      document.getElementById('obs-mood-arc').textContent = `${label} (${first.toFixed(1)} → ${latest.toFixed(1)})`;
      document.getElementById('obs-mood-fill').style.width = `${Math.round(latest * 100)}%`;
    }
    const deltaLines = [];
    if (last.symbols_added?.length) deltaLines.push(`+symbols: ${last.symbols_added.slice(0,3).join(', ')}`);
    if (last.tags_added?.length) deltaLines.push(`+tags: ${last.tags_added.slice(0,3).join(', ')}`);
    if (last.mood_delta != null && Math.abs(last.mood_delta) >= 0.05)
      deltaLines.push(`mood ${last.mood_delta > 0 ? '+' : ''}${last.mood_delta}`);
    document.getElementById('obs-last-delta').textContent = deltaLines.join(' · ') || 'no change';
    if (last.convergence != null) {
      const pct = Math.round(last.convergence * 100);
      document.getElementById('obs-convergence').textContent = `${pct}%`;
      document.getElementById('obs-conv-fill').style.width = `${pct}%`;
    }
  }).catch(() => {});
}

setInterval(() => {
  if (!document.getElementById('observer-panel').classList.contains('collapsed')) refreshObserver();
}, 30000);

// ── Context management ────────────────────────────────────────────────────────
let contextMode = { search: true, memory: true, trading: false };

function updateContext() {
  contextMode = {
    search: document.getElementById('ctx-search').checked,
    memory: document.getElementById('ctx-memory').checked,
    trading: document.getElementById('ctx-trading').checked,
  };
  localStorage.setItem('contextMode', JSON.stringify(contextMode));
}

try {
  const saved = JSON.parse(localStorage.getItem('contextMode') || '{}');
  Object.assign(contextMode, saved);
  document.getElementById('ctx-search').checked = contextMode.search;
  document.getElementById('ctx-memory').checked = contextMode.memory;
  document.getElementById('ctx-trading').checked = contextMode.trading;
} catch (e) {}

// ── Performance monitoring ────────────────────────────────────────────────────
let perfStats = { totalTokens: 0, totalCost: 0, lastLatency: 0 };

function togglePerfMonitor() {
  const enabled = document.getElementById('ctx-perf').checked;
  document.getElementById('perf-monitor').style.display = enabled ? 'block' : 'none';
  localStorage.setItem('perfMonitorEnabled', enabled);
}

const perfEnabled = localStorage.getItem('perfMonitorEnabled') === 'true';
if (perfEnabled) {
  document.getElementById('ctx-perf').checked = true;
  document.getElementById('perf-monitor').style.display = 'block';
}

function updatePerfStats(tokens, cost, latency) {
  perfStats.totalTokens += tokens || 0;
  perfStats.totalCost += cost || 0;
  perfStats.lastLatency = latency || 0;
  document.getElementById('perf-tokens').textContent = perfStats.totalTokens.toLocaleString();
  document.getElementById('perf-cost').textContent = '$' + perfStats.totalCost.toFixed(3);
  document.getElementById('perf-latency').textContent = perfStats.lastLatency + 'ms';
}

const origFetch = window.fetch;
window.fetch = async function(...args) {
  const startTime = Date.now();
  const response = await origFetch.apply(this, args);
  if (args[0] && args[0].includes('dream/chat')) {
    const latency = Date.now() - startTime;
    const tokens = parseInt(response.headers?.get('X-Tokens-Used') || '0');
    const cost = parseFloat(response.headers?.get('X-Cost-Usd') || '0');
    if (tokens || cost) updatePerfStats(tokens, cost, latency);
  }
  return response;
};

// ── Workspace — Sigma-0 observable autonomous coding (issue #527) ─────────────
// Pillar 1 (A2): live step log + diff viewer
// Pillar 2 (B1/B2/B3): approval gates before apply, commit, PR
// Pillar 3 (C1/C2): receipt derived from what actually happened

async function runWorkspace(request) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const uid = 'wks-' + Date.now();

  if (!document.getElementById('wks-style')) {
    const st = document.createElement('style');
    st.id = 'wks-style';
    st.textContent = `
.wks{background:#12121e;border:1px solid rgba(124,58,237,.35);border-radius:10px;overflow:hidden;font-size:12px;margin-top:4px}
.wks-hd{background:rgba(124,58,237,.12);padding:10px 14px;font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;border-bottom:1px solid rgba(124,58,237,.2)}
.wks-step{display:flex;align-items:flex-start;gap:10px;padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.05)}
.wks-step-icon{font-size:14px;margin-top:1px;min-width:18px}
.wks-step-info{flex:1;min-width:0}
.wks-step-label{font-weight:500;display:flex;align-items:center;gap:6px;margin-bottom:2px}
.wks-step-body{color:rgba(205,214,244,.55);line-height:1.55;margin-top:3px}
.wks-badge{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;letter-spacing:.04em}
.wks-badge.run{background:rgba(245,166,35,.2);color:#f5a623}
.wks-badge.ok{background:rgba(63,185,80,.2);color:#3fb950}
.wks-badge.err{background:rgba(248,81,73,.2);color:#f85149}
.wks-badge.wait{background:rgba(255,255,255,.06);color:rgba(205,214,244,.35)}
.wks-badge.skip{background:rgba(255,255,255,.06);color:rgba(205,214,244,.35)}
.wks-diff{background:#0d1117;padding:10px;border-radius:4px;font-family:monospace;font-size:10.5px;overflow:auto;max-height:240px;white-space:pre;margin:6px 0;line-height:1.4}
.wks-diff .a{color:#3fb950}.wks-diff .d{color:#f85149}.wks-diff .h{color:#58a6ff}.wks-diff .m{color:#6e7681}
.wks-actions{padding:10px 14px;display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.06)}
.wks-btn{border:none;border-radius:5px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;font-weight:500;transition:opacity .15s}
.wks-btn:disabled{opacity:.35;cursor:default}
.wks-btn.g{background:rgba(63,185,80,.75);color:#fff}.wks-btn.g:hover:not(:disabled){background:#3fb950}
.wks-btn.x{background:rgba(248,81,73,.1);color:#f85149;border:1px solid rgba(248,81,73,.3)}.wks-btn.x:hover:not(:disabled){background:rgba(248,81,73,.2)}
.wks-btn.s{background:rgba(255,255,255,.07);color:rgba(205,214,244,.8);border:1px solid rgba(255,255,255,.1)}.wks-btn.s:hover:not(:disabled){background:rgba(255,255,255,.12)}
.wks-tag{background:rgba(124,58,237,.18);border-radius:3px;padding:1px 6px;font-size:10px;color:rgba(205,214,244,.7);display:inline-block;margin:1px 2px}
.wks-tag.risk-high{background:rgba(248,81,73,.18);color:#f85149}
.wks-tag.risk-low{background:rgba(63,185,80,.18);color:#3fb950}
.wks-tag.risk-medium{background:rgba(245,166,35,.18);color:#f5a623}
.wks-receipt{padding:10px 14px;font-size:11px;border-top:1px solid rgba(63,185,80,.2);background:rgba(63,185,80,.04);color:rgba(205,214,244,.65);line-height:1.7}
.wks-test{background:#0d1117;border-radius:4px;padding:6px 8px;font-size:10.5px;font-family:monospace;margin-top:4px}`.trim();
    document.head.appendChild(st);
  }

  const container = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = 'message agent';
  el.innerHTML = `<div class="message-content"><div class="wks">
    <div class="wks-hd">⚙&thinsp;Workspace&ensp;<span style="opacity:.5;font-weight:400;font-size:11px">${esc(request.slice(0,80))}${request.length>80?'…':''}</span></div>
    <div id="${uid}-steps"></div>
    <div id="${uid}-actions" class="wks-actions" style="display:none"></div>
    <div id="${uid}-receipt" class="wks-receipt" style="display:none"></div>
  </div></div>`;
  container.appendChild(el);

  const stEl = () => document.getElementById(uid+'-steps');
  const actEl = () => document.getElementById(uid+'-actions');
  const rcEl  = document.getElementById(uid+'-receipt');
  const scroll = () => { container.scrollTop = container.scrollHeight; };

  const BADGE = { run:'running…', ok:'done', err:'failed', wait:'waiting', skip:'skipped' };

  function addStep(icon, label, status, body) {
    const row = document.createElement('div');
    row.className = 'wks-step';
    row.innerHTML = `<div class="wks-step-icon">${icon}</div>
      <div class="wks-step-info">
        <div class="wks-step-label">${esc(label)}&ensp;<span class="wks-badge ${status}">${BADGE[status]||status}</span></div>
        <div class="wks-step-body">${body||''}</div>
      </div>`;
    stEl().appendChild(row);
    scroll();
    return row;
  }

  function upStep(row, status, body) {
    const b = row.querySelector('.wks-badge');
    b.className = 'wks-badge '+status;
    b.textContent = BADGE[status]||status;
    if (body !== undefined) row.querySelector('.wks-step-body').innerHTML = body;
    scroll();
  }

  function setAct(html) {
    const a = actEl(); a.style.display = html ? 'flex' : 'none'; a.innerHTML = html||''; scroll();
  }

  function gate(choices) {
    return new Promise(resolve => {
      choices.forEach(({id, val}) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', () => {
          choices.forEach(({id:bid}) => { const b=document.getElementById(bid); if(b) b.disabled=true; });
          resolve(val);
        }, {once:true});
      });
    });
  }

  const receipt = { ts: new Date().toISOString(), request, plan:null, applied:false, tests:null, committed:false, pushed:false, prUrl:null, decisions:[] };

  // ── Step 1: Plan (A1) ─────────────────────────────────────────────────
  const planRow = addStep('📋','Plan','run','');
  let plan;
  try {
    const r = await fetch('/api/self-edit/plan', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request})});
    const d = await r.json();
    if (!d.ok) throw new Error(d.error||'plan_failed');
    plan = d.plan;
    receipt.plan = {summary:plan.summary, riskLevel:plan.riskLevel, files:plan.affectedFiles};
    const rCls = 'risk-'+(plan.riskLevel||'medium');
    const tags = [`<span class="wks-tag ${rCls}">⚠ ${esc(plan.riskLevel)}</span>`,
      ...(plan.affectedFiles||[]).map(f=>`<span class="wks-tag">${esc(f)}</span>`)].join('');
    const stepsHtml = (plan.steps||[]).map((s,i)=>`${i+1}. <b>${esc(s.action)}</b> ${esc(s.file||'')} — ${esc(s.description)}`).join('<br>');
    upStep(planRow,'ok',`<div style="margin-bottom:4px">${esc(plan.summary)}</div><div style="margin:4px 0">${tags}</div>${stepsHtml?`<div style="margin-top:4px">${stepsHtml}</div>`:''}`);
  } catch(e) { upStep(planRow,'err',esc(e.message)); return; }

  // ── Step 2: Diff preview (A2) ─────────────────────────────────────────
  const patchRow = addStep('📄','Diff preview','run','');
  let diffText, changedFiles;
  try {
    const r = await fetch('/api/self-edit/patch', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan})});
    const d = await r.json();
    if (!d.ok) throw new Error(d.error||'patch_failed');
    diffText = d.diffText; changedFiles = d.changedFiles||[];
    try { receipt.diffHash = btoa(diffText).slice(0,10); } catch{}
    const lines = diffText.split('\n');
    const diffHtml = lines.slice(0,200).map(ln=>{
      if (ln.startsWith('+++') || ln.startsWith('---')) return `<span class="m">${esc(ln)}</span>`;
      if (ln.startsWith('+')) return `<span class="a">${esc(ln)}</span>`;
      if (ln.startsWith('-')) return `<span class="d">${esc(ln)}</span>`;
      if (ln.startsWith('@@')) return `<span class="h">${esc(ln)}</span>`;
      return esc(ln);
    }).join('\n');
    const trunc = lines.length>200 ? `<div style="opacity:.4;font-size:10px;margin-top:3px">…truncated (showing 200 of ${lines.length} lines)</div>` : '';
    upStep(patchRow,'ok',`<div style="margin-bottom:4px;opacity:.7">${changedFiles.map(esc).join(', ')||'(no files)'}</div><div class="wks-diff">${diffHtml}</div>${trunc}`);
  } catch(e) { upStep(patchRow,'err',esc(e.message)); return; }

  // ── Gate B1: diff approval ─────────────────────────────────────────────
  setAct(`<button class="wks-btn g" id="${uid}-b1y">✓ Apply changes</button><button class="wks-btn x" id="${uid}-b1n">✗ Cancel</button>`);
  const approved = await gate([{id:uid+'-b1y',val:true},{id:uid+'-b1n',val:false}]);
  setAct(null);
  receipt.decisions.push({gate:'B1',choice:approved?'approve':'cancel',ts:new Date().toISOString()});
  if (!approved) { addStep('🚫','Cancelled','skip','No files changed.'); showWksReceipt(receipt,rcEl); return; }

  // ── Step 3: Apply + test (B2) ─────────────────────────────────────────
  const applyRow = addStep('⚡','Apply + test','run','');
  let allOk = false;
  try {
    const r = await fetch('/api/self-edit/apply', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({diffText, testsToRun:plan.testsToRun||[]})});
    const d = await r.json();
    if (!d.ok) throw new Error(d.error||'apply_failed');
    receipt.applied = true;
    allOk = d.allTestsOk !== false;
    const tests = d.tests||[];
    receipt.tests = {passed:allOk, count:tests.length};
    const applied = [...(d.applied?.changed||[]),(d.applied?.created||[])].flat();
    const errs = d.applied?.errors||[];
    const testsHtml = tests.length===0
      ? '<div style="opacity:.4;margin-top:4px">No tests configured</div>'
      : tests.map(t=>`<div class="wks-test"><span style="color:${t.ok?'#3fb950':'#f85149'}">${t.ok?'✓':'✗'} ${esc(t.cmd)}</span>${t.output?`<pre style="margin:3px 0 0;opacity:.6;font-size:10px;max-height:80px;overflow:auto">${esc(t.output.slice(0,400))}</pre>`:''}${t.error?`<pre style="margin:3px 0 0;color:#f85149;font-size:10px">${esc(String(t.error).slice(0,300))}</pre>`:''}</div>`).join('');
    upStep(applyRow, allOk?'ok':'err', `<div style="margin-bottom:4px">${applied.map(esc).join(', ')||'applied'}</div>${errs.length?`<div style="color:#f85149;margin-bottom:4px">${errs.map(e=>esc(e.file+': '+e.error)).join('<br>')}</div>`:''}${testsHtml}`);
  } catch(e) { upStep(applyRow,'err',esc(e.message)); showWksReceipt(receipt,rcEl); return; }

  // Gate B2: block commit if tests failed
  if (!allOk) { addStep('🧪','Tests failed — commit blocked','err','Fix failing tests before opening a PR. Working tree was modified.'); showWksReceipt(receipt,rcEl); return; }

  // ── Gate B3: commit/PR confirmation ──────────────────────────────────
  setAct(`<button class="wks-btn g" id="${uid}-b3y">🔗 Create draft PR</button><button class="wks-btn s" id="${uid}-b3n">◉ Stop here (no commit)</button>`);
  const wantPr = await gate([{id:uid+'-b3y',val:true},{id:uid+'-b3n',val:false}]);
  setAct(null);
  receipt.decisions.push({gate:'B3',choice:wantPr?'create_pr':'stop',ts:new Date().toISOString()});
  if (!wantPr) { addStep('✓','Applied — no PR','ok','Changes applied locally. No commit created.'); showWksReceipt(receipt,rcEl); return; }

  // ── Step 4: PR (B3) ──────────────────────────────────────────────────
  const prRow = addStep('🔗','Commit + PR','run','');
  try {
    const r = await fetch('/api/self-edit/pr', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      title: plan.summary||'auto: '+request.slice(0,60),
      body: `Auto-generated via Workspace\n\n**Request:** ${request}\n\n**Plan:** ${plan.summary}`,
      branch: plan.branchHint||'auto-change'
    })});
    const d = await r.json();
    if (!d.ok) throw new Error(d.error||'pr_failed');
    receipt.committed = true; receipt.pushed = d.pushed||false; receipt.prUrl = d.prUrl;
    upStep(prRow,'ok',`Branch: <code style="opacity:.8">${esc(d.branch)}</code><br>${d.prUrl?`<a href="${esc(d.prUrl)}" target="_blank" style="color:#58a6ff">${esc(d.prUrl)}</a>`:'(no URL returned)'}${d.prError?`<br><span style="color:#f5a623;font-size:10px">${esc(d.prError)}</span>`:''}`);
  } catch(e) { upStep(prRow,'err',esc(e.message)); }

  showWksReceipt(receipt,rcEl);
}

// C1/C2: receipt derived only from what actually happened — no templated success
function showWksReceipt(receipt, el) {
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const ts = receipt.ts.slice(0,16).replace('T',' ');
  const dec = receipt.decisions.map(d=>`<b>${d.gate}</b>:${d.choice}`).join(' · ')||'none';
  const testStr = receipt.tests ? `${receipt.tests.passed?'✓':'✗'} tests (${receipt.tests.count})` : 'no tests';
  const prStr = receipt.prUrl ? `<a href="${esc(receipt.prUrl)}" target="_blank" style="color:#58a6ff">PR open →</a>` : receipt.committed ? 'committed (no PR URL)' : '—';
  el.style.display = 'block';
  el.innerHTML = `<b style="color:#3fb950">Receipt</b> · ${ts}<br>${testStr} · committed:${receipt.committed?'✓':'✗'} · pushed:${receipt.pushed?'✓':'✗'} · ${prStr}<br>Gates: ${dec}`;
  try {
    const log = JSON.parse(sessionStorage.getItem('wks-receipts')||'[]');
    log.push(receipt);
    sessionStorage.setItem('wks-receipts', JSON.stringify(log.slice(-20)));
  } catch {}
}
