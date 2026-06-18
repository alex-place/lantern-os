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
  const thinking = document.createElement('span');
  thinking.className = 'thinking-mandala';
  thinking.innerHTML = '<img src="/mandala.svg" alt="" style="width:20px;height:20px;opacity:0.5;animation:spin 2s linear infinite;vertical-align:middle">';
  bubble.appendChild(thinking);
  const cursor = document.createElement('span');
  cursor.className = 'stream-cursor';
  bubble.appendChild(cursor);
  msg.appendChild(bubble);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return { msg, bubble, cursor, thinking };
}

// ── Main send ─────────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || isSending) return;

  // Three-doors game lives on its own page now — Lantern guides there, not in chat
  const kingdomeMatch = text.match(/^!(?:three-doors|threedoors|doors|kingdome|kingdome-of-hearts|explore)\b/i);
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
          if (a.href) btn.onclick = () => { window.open(a.href, '_blank', 'noopener'); };
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
                const errRow = document.createElement('div');
                errRow.className = 'msg-row agent';
                errRow.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px;color:#f87171">✗ Auto-work error: ${e.message}</div>`;
                messages.appendChild(errRow);
                if (typeof scrollToBottom === 'function') scrollToBottom();
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

  // !work / !edit — observable autonomous workspace (Sigma-0, issue #527)
  const workMatch = text.match(/^!(?:work|edit)\s+([\s\S]+)/i);
  if (workMatch) {
    input.value = '';
    addUserBubble(text);
    runWorkspace(workMatch[1].trim()).catch(err => console.error('[workspace]', err));
    return;
  }

  // Auto-route work/status queries to convergence agent (no LLM cost, instant)
  const WORK_INTENT = /\b(what (work|issues?|tasks?|bugs?|tickets?|pr[s']?|pull requests?)|what (needs?|needs to be) (done|fixed|closed|worked on)|what'?s? (open|pending|left|next|the status|blocking)|show (me )?(open |the )?issues?|status (of|update)|list (issues?|tasks?|open)|open issues?|any issues?|what should i (work on|fix|do)|top issues?|priority (issues?|tasks?))\b/i;
  if (WORK_INTENT.test(text) && !text.startsWith('!')) {
    input.value = '';
    input.style.height = 'auto';
    const base = (typeof serverBase !== 'undefined') ? serverBase : window.location.origin;
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
        body: JSON.stringify({ message: text }),
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
          if (a.href) btn.onclick = () => window.open(a.href, '_blank', 'noopener');
          else if (a.autonomous && a.issue) {
            btn.onclick = async () => {
              btn.disabled = true; btn.textContent = 'Working…';
              try {
                const wr = await fetch(`${base}/api/convergence/autonomous-work`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issue: a.issue }) });
                const wres = await wr.json();
                if (wres.ok) { btn.textContent = '✓ Done'; btn.style.color = '#4ade80'; }
                else {
                  btn.textContent = '✗ Failed';
                  btn.style.color = '#f87171';
                  const errRow = document.createElement('div');
                  errRow.className = 'msg-row agent';
                  errRow.innerHTML = `<div class="msg-label">Keystone</div><div class="bubble" style="font-size:13px;color:#f87171">✗ Auto-work failed: ${wres.error || 'unknown error'}</div>`;
                  document.getElementById('messages').appendChild(errRow);
                  if (typeof scrollToBottom === 'function') scrollToBottom();
                }
              } catch { btn.textContent = '✗ Error'; btn.style.color = '#f87171'; }
            };
          } else if (a.command) btn.onclick = () => fillAndSend(a.command);
          wrap.appendChild(btn);
        });
        bubble.appendChild(wrap);
      }
    } catch (e) {
      sysRow.querySelector('.bubble').textContent = `Convergence failed: ${e.message}`;
    }
    if (typeof scrollToBottom === 'function') scrollToBottom();
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
  let receivedDone = false;

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
            if (!bubble.querySelector('.route-card')) {
              const rc = document.createElement('div');
              rc.className = 'route-card';
              rc.textContent = evt.label || `${evt.agentName} · ${evt.surface}`;
              bubble.insertBefore(rc, cursor);
            }
          } else if (evt.type === 'token' && evt.text) {
            if (thinking.parentNode) thinking.remove();
            fullText += evt.text;
            cursor.remove();
            bubble.innerHTML = renderMarkdown(fullText.replace(/\[DOORS:[^\]]*\]?/i, '').trimEnd());
            bubble.appendChild(cursor);
            container.scrollTop = container.scrollHeight;
          } else if (evt.type === 'error') {
            didError = true;
            if (evt.text) serverErrorText = evt.text;
            if (!fullText) bubble.style.color = 'var(--muted)';
          } else if (evt.type === 'sigma0' && evt.corrected) {
            // Response was revised by Σ₀ verify pass — show badge after stream completes
            bubble.dataset.sigma0Corrected = '1';
            bubble.dataset.sigma0Claims = evt.claims || 0;
          } else if (evt.type === 'done') {
            if (evt.cleanText) fullText = evt.cleanText;
            if (evt.routeLabel) routeLabel = evt.routeLabel;
            receivedDone = true;
          }
        } catch { /* skip malformed line */ }
      }
    }
  } catch (e) { didError = true; }

  cursor.remove();

  // Truncation detection: stream ended without a done event and text looks cut off
  if (fullText && !receivedDone) {
    const truncBadge = document.createElement('span');
    truncBadge.title = 'Stream ended without completing — response may be truncated';
    truncBadge.style.cssText = 'font-size:10px;opacity:0.5;margin-left:6px;vertical-align:middle;cursor:help';
    truncBadge.textContent = '⚠ truncated';
    bubble.appendChild(truncBadge);
  }

  if (!fullText) {
    fullText = serverErrorText || FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
    msg.classList.add('error');
    bubble.style.color = 'var(--muted)';
    bubble.style.fontStyle = 'italic';
  }

  bubble.innerHTML = renderMarkdown(fullText);

  if (bubble.dataset.sigma0Corrected) {
    const badge = document.createElement('span');
    badge.title = `Σ₀ verified — ${bubble.dataset.sigma0Claims} claim(s) grounded`;
    badge.style.cssText = 'font-size:10px;opacity:0.55;margin-left:6px;vertical-align:middle';
    badge.textContent = '✓ Σ₀';
    bubble.appendChild(badge);
  }

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
