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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'Lantern OS', max_results: 3 } } }),
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

// ── Markdown + PR link renderer ───────────────────────────────────────────────
function renderMarkdown(text) {
  let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  h = h.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre class="code-block"><code>$1</code></pre>');
  h = h.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g,
    '<a href="https://github.com/$1/$2/pull/$3" target="_blank" rel="noopener" class="pr-pill">🔗 PR #$3 — $1/$2 →</a>'
  );
  h = h.replace(
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/g,
    '<a href="https://github.com/$1/$2/issues/$3" target="_blank" rel="noopener" class="issue-pill">⚑ Issue #$3 — $1/$2 →</a>'
  );
  h = h.replace(/\n/g, '<br>');
  return h;
}

// ── Conversation state ────────────────────────────────────────────────────────
let isSending = false;
const history = [];

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
  const cursor = document.createElement('span');
  cursor.className = 'stream-cursor';
  bubble.appendChild(cursor);
  msg.appendChild(bubble);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return { msg, bubble, cursor };
}

// ── Main send ─────────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || isSending) return;

  // Three-doors game lives on its own page now — Lantern guides there, not in chat
  const kingdomeMatch = text.match(/^!(?:three-doors|threedoors|doors|kingdome|kingdome-of-hearts)\b/i);
  if (kingdomeMatch) {
    input.value = '';
    window.location.href = '/three-doors-game.html';
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

  // !ask <question> — deterministic convergence agent (no LLM): answer + actions
  const askMatch = text.match(/^!ask\s+(.+)/i);
  if (askMatch) {
    input.value = '';
    input.style.height = 'auto';
    const base = (typeof serverBase !== 'undefined') ? serverBase : window.location.origin;
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    addUserBubble(text);
    const messages = document.getElementById('messages');
    const sysRow = document.createElement('div');
    sysRow.className = 'msg-row agent';
    sysRow.innerHTML = '<div class="msg-label">Convergence</div><div class="bubble" style="font-size:13px">Routing locally…</div>';
    messages.appendChild(sysRow);
    if (typeof scrollToBottom === 'function') scrollToBottom();
    try {
      const r = await fetch(`${base}/api/convergence/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: askMatch[1].trim() }),
      });
      const d = await r.json();
      const bubble = sysRow.querySelector('.bubble');
      const badge = d.grounded ? '⚡ Instant answer · from live repo data' : '⚡ Instant answer · no AI cost';
      const meta = `<div style="font-size:11px;opacity:0.55;margin-top:8px">${badge}</div>`;
      bubble.innerHTML = `<div style="white-space:pre-wrap;line-height:1.5">${esc(d.answer || '(no answer)')}</div>` + meta;
      const acts = Array.isArray(d.actions) ? d.actions : [];
      if (acts.length) {
        const wrap = document.createElement('div');
        wrap.className = 'starter-chips';
        wrap.style.marginTop = '10px';
        acts.forEach(a => {
          const btn = document.createElement('button');
          btn.className = 'starter-chip';
          btn.textContent = a.label;
          if (a.href) btn.onclick = () => { window.location.href = a.href; };
          else if (a.autonomous && a.issue) {
            btn.onclick = async () => {
              btn.disabled = true;
              btn.textContent = 'Working…';
              try {
                const workResp = await fetch(`${base}/api/convergence/autonomous-work`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ issue: a.issue }),
                });
                const workResult = await workResp.json();
                if (workResult.ok) {
                  btn.textContent = '✓ Done';
                  btn.style.color = '#4ade80';
                  const resultRow = document.createElement('div');
                  resultRow.className = 'msg-row agent';
                  resultRow.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px">✓ Auto-worked #${workResult.issue}<br><a href="${workResult.prUrl}" target="_blank" style="color:var(--accent)">View PR</a></div>`;
                  messages.appendChild(resultRow);
                } else {
                  btn.textContent = '✗ Failed';
                  btn.style.color = '#f87171';
                  const errorRow = document.createElement('div');
                  errorRow.className = 'msg-row agent';
                  errorRow.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px;color:#f87171">✗ Auto-work failed: ${workResult.error}</div>`;
                  messages.appendChild(errorRow);
                }
                if (typeof scrollToBottom === 'function') scrollToBottom();
              } catch (e) {
                btn.textContent = '✗ Error';
                btn.style.color = '#f87171';
              }
            };
          }
          else if (a.command) btn.onclick = () => fillAndSend(a.command);
          wrap.appendChild(btn);
        });
        bubble.appendChild(wrap);
      }
      if (typeof scrollToBottom === 'function') scrollToBottom();
    } catch (e) {
      sysRow.querySelector('.bubble').textContent = `Convergence agent failed: ${e.message}`;
    }
    return;
  }

  isSending = true;
  document.getElementById('send-btn').disabled = true;

  addUserBubble(text);
  input.value = '';
  input.style.height = 'auto';
  history.push({ role: 'user', text });
  writeCubeDelta('chat_message', [], 'conversation:' + Date.now());

  const { msg, bubble, cursor } = createAgentBubble(false);
  const container = document.getElementById('messages');

  let fullText = '';
  let serverErrorText = '';
  let didError = false;
  let routeLabel = '';

  try {
    const provider = document.getElementById('provider-select')?.value || '';
    const resp = await fetch('/api/dream/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        user: 'dream-chat',
        provider,
        history: history.slice(-10),
        personalContext: sanitizePersonalContext(personalContext || {}),
      }),
      signal: AbortSignal.timeout(90000),
    });

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
            if (!document.querySelector('.route-card')) {
              const rc = document.createElement('div');
              rc.className = 'route-card';
              rc.textContent = evt.label || `${evt.agentName} · ${evt.surface}`;
              bubble.insertBefore(rc, cursor);
            }
          } else if (evt.type === 'token' && evt.text) {
            fullText += evt.text;
            cursor.remove();
            bubble.innerHTML = renderMarkdown(fullText.replace(/\[DOORS:[^\]]*\]?/i, '').trimEnd());
            bubble.appendChild(cursor);
            container.scrollTop = container.scrollHeight;
          } else if (evt.type === 'error') {
            didError = true;
            if (evt.text) serverErrorText = evt.text;
            if (!fullText) bubble.style.color = 'var(--muted)';
          } else if (evt.type === 'done') {
            if (evt.cleanText) fullText = evt.cleanText;
            if (evt.routeLabel) routeLabel = evt.routeLabel;
          }
        } catch { /* skip malformed line */ }
      }
    }
  } catch (e) { didError = true; }

  cursor.remove();

  if (!fullText) {
    fullText = serverErrorText || FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
    msg.classList.add('error');
    bubble.style.color = 'var(--muted)';
    bubble.style.fontStyle = 'italic';
  }

  bubble.innerHTML = renderMarkdown(fullText);

  if (routeLabel) {
    const sig = document.createElement('div');
    sig.className = 'msg-route-sig';
    sig.setAttribute('aria-label', `Active route: ${routeLabel}`);
    sig.textContent = routeLabel;
    msg.appendChild(sig);
  }

  if (!didError) history.push({ role: 'assistant', text: fullText });

  isSending = false;
  document.getElementById('send-btn').disabled = false;
}

// ── Auto-expand textarea ──────────────────────────────────────────────────────
document.getElementById('input').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
});

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
