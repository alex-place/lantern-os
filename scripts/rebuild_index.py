import os

BASE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "lantern-garage", "public"))
JS_PATH = os.path.join(BASE, "_temp_script.js")
OLD_PATH = os.path.join(BASE, "index.html")
NEW_PATH = os.path.join(BASE, "index.html.new")

with open(JS_PATH, "r", encoding="utf-8") as f:
    js = f.read()

html = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Cache-Control" content="no-store">
  <title>Dream Journal — Orion by Lantern OS</title>
  <link rel="stylesheet" href="dream-journal.css?v=20260602-orion-v1">
  <style>
    .message { padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-size: 0.9rem; font-weight: 600; }
    .message.success { background: #e6f5e6; color: #2d6a2d; border: 1px solid #b8e0b8; }
    .message.error { background: #f5e6e6; color: #8b2d2d; border: 1px solid #e0b8b8; }
    #message { display: none; }

    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 16px 0 20px; }
    .stat-card { text-align: center; padding: 14px; border-radius: 16px; background: rgba(255,255,255,0.7); border: 1px solid var(--panel-border); }
    .stat-number { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.8rem; font-weight: 700; color: var(--celestial-ink); }
    .stat-label { font-size: 0.78rem; color: var(--text-muted); margin-top: 4px; }

    .chat-card { border-radius: var(--radius-lg); overflow: hidden; }
    .chat-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: linear-gradient(135deg, var(--celestial-deep), var(--dream-purple)); color: white; font-weight: 700; border-radius: var(--radius-md) var(--radius-md) 0 0; }
    .chat-status { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 0.8rem; font-weight: 500; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; display: inline-block; }
    .status-dot.offline { background: #f87171; }
    .chat-log { min-height: 180px; max-height: 360px; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--panel-bg-solid); border: 1px solid var(--panel-border); border-top: none; border-bottom: none; }
    .bubble-wrapper { display: flex; flex-direction: column; gap: 4px; }
    .bubble-label { font-size: 0.7rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .bubble { max-width: 80%; padding: 10px 14px; border-radius: 16px; font-size: 0.9rem; line-height: 1.45; word-break: break-word; }
    .bubble.operator { align-self: flex-end; background: linear-gradient(135deg, var(--celestial-deep), var(--dream-purple)); color: white; border-bottom-right-radius: 4px; }
    .bubble.lantern { align-self: flex-start; background: var(--celestial-faint); color: var(--text-primary); border-bottom-left-radius: 4px; }
    .bubble img { max-width: 100%; border-radius: 12px; margin-bottom: 6px; display: block; }
    .bubble-caption { font-size: 0.78rem; color: var(--text-muted); font-style: italic; margin-top: 4px; }
    .cursor::after { content: '|'; animation: blink 1s step-end infinite; color: var(--dream-purple); }
    @keyframes blink { 50% { opacity: 0; } }
    .chat-suggestions { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; background: var(--panel-bg-solid); border: 1px solid var(--panel-border); border-top: none; border-radius: 0 0 var(--radius-md) var(--radius-md); }
    .chip { padding: 6px 14px; border-radius: 100px; border: 1px solid var(--panel-border); background: var(--panel-bg); color: var(--text-secondary); font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .chip:hover { background: var(--celestial-ink); color: white; border-color: var(--celestial-ink); }
    .chat-input-row { display: flex; gap: 8px; padding: 12px; background: var(--panel-bg-solid); border: 1px solid var(--panel-border); border-top: none; border-radius: 0 0 var(--radius-md) var(--radius-md); }
    .chat-input-row input { flex: 1; padding: 10px 14px; border: 1px solid var(--panel-border); border-radius: 100px; background: white; font: inherit; font-size: 0.9rem; }
    .chat-input-row input:focus { outline: none; border-color: var(--dream-purple); box-shadow: 0 0 0 3px rgba(139,126,200,0.12); }
    .chat-input-row button { padding: 10px 18px; border: none; border-radius: 100px; background: linear-gradient(135deg, var(--celestial-deep), var(--dream-purple)); color: white; font: inherit; font-weight: 700; cursor: pointer; transition: transform 0.15s; }
    .chat-input-row button:hover { transform: scale(1.05); }
    .chat-input-row button:last-child { background: var(--celestial-faint); color: var(--text-secondary); }

    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    @media (max-width: 560px) { .form-row { grid-template-columns: 1fr; } }
    .entries { min-height: 60px; }
    .empty-state { text-align: center; color: var(--text-muted); padding: 24px; font-size: 0.9rem; }

    #outreach-section { margin-top: 20px; }
    #outreach-section a { color: var(--dream-purple); text-decoration: none; font-weight: 600; }
    #outreach-section a:hover { text-decoration: underline; }

    #refresh { margin: 8px 0 16px; padding: 8px 16px; border: 1px solid var(--panel-border); border-radius: 100px; background: var(--panel-bg); color: var(--text-secondary); font: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    #refresh:hover { background: var(--celestial-ink); color: white; }
  </style>
</head>
<body>
  <div class="dream-shell">
    <header class="dream-hero">
      <div class="hero-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      </div>
      <p class="eyebrow">Lantern OS</p>
      <h1>Dream Journal</h1>
      <p class="byline">Orion Edition</p>
      <p class="tagline">Remember your dreams.<br>Reflect on what they mean.</p>
      <p class="subtagline">A private dream-journaling space with guided prompts, saved notes, notebook recall, and a Discord companion.</p>
      <div class="privacy-badge" role="img" aria-label="Privacy shield">
        <svg class="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        <span>Your dreams. Your space. Always private.</span>
      </div>
      <nav class="dream-nav" aria-label="Dreamer sections">
        <a href="/" aria-current="page">Journal</a>
        <a href="/courtney.html">The Well</a>
        <a href="/wish-door.html">Wish Door</a>
      </nav>
    </header>

    <section class="features-strip" aria-label="Features">
      <article class="feature-card"><div class="icon">&#128211;</div><h3>Save Dreams</h3><p>Capture dreams before they fade.</p></article>
      <article class="feature-card"><div class="icon">&#128172;</div><h3>Follow Prompts</h3><p>Guided questions to help you reflect.</p></article>
      <article class="feature-card"><div class="icon">&#128220;</div><h3>Revisit Patterns</h3><p>Find meaning in your memories over time.</p></article>
      <article class="feature-card"><div class="icon">&#128126;</div><h3>Discord Companion</h3><p>Journal inside our community and keep your dreams alive.</p></article>
      <article class="feature-card"><div class="icon">&#128682;</div><h3>ImaginVerses</h3><p>Step through doors to new worlds you build with friends.</p></article>
    </section>

    <main class="dream-main">
      <section class="dream-panel" aria-label="Dream Journal Chat">
        <div class="panel-header">
          <h2>Talk to your Dream Journal</h2>
          <p class="panel-desc">Share a dream, ask about the doors, or just say hello.</p>
        </div>
        <div class="panel-body">
          <div id="message"></div>
          <div class="chat-card">
            <div class="chat-header">
              <span>🌙</span>
              <strong>Dream Journal</strong>
              <span class="chat-status">
                <span class="status-dot" id="statusDot"></span>
                <span id="statusText">Online</span>
              </span>
            </div>
            <div class="chat-log" id="chatLog"></div>
            <div class="chat-suggestions" id="chatSuggestions"></div>
            <div class="chat-input-row">
              <input type="text" id="chatInput" placeholder="Tell me a dream, a door, or a feeling..." autocomplete="off">
              <button id="chatSend" type="button">Send</button>
              <button id="chatClear" type="button" title="Clear chat memory">Clear</button>
            </div>
          </div>
        </div>
      </section>

      <section class="dream-panel" aria-label="Journal entries and form">
        <div class="panel-header">
          <h2>Your Journal</h2>
          <p class="panel-desc">Log a new entry or review what you have saved.</p>
        </div>
        <div class="panel-body">
          <div class="stats">
            <div class="stat-card"><div class="stat-number" id="totalCount">0</div><div class="stat-label">Total Entries</div></div>
            <div class="stat-card"><div class="stat-number" id="dreamCount">0</div><div class="stat-label">Dreams</div></div>
            <div class="stat-card"><div class="stat-number" id="noteCount">0</div><div class="stat-label">Notes</div></div>
            <div class="stat-card"><div class="stat-number" id="avgLucidity">--</div><div class="stat-label">Avg Lucidity</div></div>
          </div>

          <section id="outreach-section">
            <h3 style="font-size:0.95rem;margin-bottom:6px;">Outreach Program</h3>
            <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:6px;"><a href="/outreach.html">Outreach Program</a></p>
            <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:6px;">20260530-kalshi-packet</p>
            <p style="font-size:0.85rem;color:var(--text-muted);"><a href="/view?path=docs/ARC-REACTOR-MINING-LAB.md">Mining lab notes</a> (solo-mining skill archived)</p>
          </section>

          <section aria-label="Primary controls">
            <button type="button" id="refresh">Refresh</button>
          </section>

          <h3 style="margin:20px 0 10px;font-family:'Cormorant Garamond',serif;font-size:1.1rem;color:var(--celestial-ink);">New Entry</h3>
          <form id="entryForm" class="dream-form">
            <label for="text">What do you want to remember?</label>
            <textarea id="text" name="text" placeholder="Write freely. What was vivid? What mattered? What surprised you?" required></textarea>

            <div class="form-row">
              <div>
                <label for="emotions">Emotions (comma-separated)</label>
                <input type="text" id="emotions" name="emotions" placeholder="e.g., clarity, wonder, peace, curiosity">
              </div>
              <div>
                <label for="lucidity">Lucidity (0 = asleep, 1 = awake)</label>
                <input type="number" id="lucidity" name="lucidity" min="0" max="1" step="0.1" value="0.5">
              </div>
            </div>

            <label for="tags">Tags (comma-separated)</label>
            <input type="text" id="tags" name="tags" placeholder="e.g., lantern, learning, home, family">

            <button type="submit">Save Entry</button>
          </form>

          <h3 style="margin:24px 0 10px;font-family:'Cormorant Garamond',serif;font-size:1.1rem;color:var(--celestial-ink);">Recent Entries</h3>
          <div class="entries" id="entriesList"></div>
        </div>
      </section>
    </main>

    <footer class="dream-footer">
      <p>Dream Journal Orion — CSF v0.7 Symbolic Qutrit Edition</p>
      <p class="creator">Created by Alex Place</p>
      <div class="footer-note">
        <strong>Lantern Principle:</strong> Visible enough to trust. Small enough not to burn the house down.
      </div>
    </footer>
  </div>

  <script>
""" + js + """
  </script>
</body>
</html>
"""

with open(NEW_PATH, "w", encoding="utf-8") as f:
    f.write(html)

os.replace(NEW_PATH, OLD_PATH)
print("Rebuilt index.html")
