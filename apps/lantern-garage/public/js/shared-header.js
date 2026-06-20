// ── Shared Global Header/Footer ──────────────────────────────────────────
// Injects consistent header into all pages

function initializeSharedHeader() {
  // Create header HTML
  const headerHTML = `
    <nav class="global-nav">
      <div class="global-nav-inner">
        <a class="global-nav-brand" href="/">
          <img src="/mandala.svg" alt="" aria-hidden="true">
          <span>Keystone OS</span>
        </a>

        <div class="global-nav-center">
          <a href="/dream-chat.html" class="global-nav-link" data-nav-path="/dream-chat.html">Chat</a>
          <a href="/trader-dashboard.html" class="global-nav-link" data-nav-path="/trader-dashboard.html">Trader</a>
          <a href="/create.html" class="global-nav-link" data-nav-path="/create.html">Create</a>
          <a href="/explore.html" class="global-nav-link" data-nav-path="/explore.html">Explore</a>
          <a href="/knowledgecenter.html" class="global-nav-link" data-nav-path="/knowledgecenter.html">Help</a>
          <a href="/admin-flags.html" class="global-nav-link global-nav-admin" data-admin-only style="display:none">Admin</a>
          <span class="global-nav-sep">·</span>
          <a href="https://www.patreon.com/lanternos" class="global-nav-link global-nav-support" target="_blank" rel="noopener noreferrer">♥ Support on Patreon</a>
        </div>

        <div class="global-nav-actions">
          <button class="global-nav-theme" id="global-theme-btn" aria-label="Toggle dark/light mode" title="Toggle theme">
            <span class="theme-icon">🌙</span>
          </button>
        </div>
      </div>
    </nav>
  `;

  // Create footer HTML
  const footerHTML = `
    <footer class="global-footer">
      <div class="global-footer-inner">
        <span class="global-footer-brand">
          <span class="dot online" id="status-dot" title="Server status" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80;margin-right:8px;vertical-align:middle"></span>
          <span class="mandala-icon" aria-hidden="true" style="display:inline-block;margin-right:4px">⬡</span>
          Keystone OS
        </span>
        <span class="global-footer-sep">·</span>
        <a href="/">Home</a>
        <span class="global-footer-sep">·</span>
        <a href="/dream-chat.html">Chat</a>
        <span class="global-footer-sep">·</span>
        <a href="/trader-dashboard.html">Trader</a>
        <span class="global-footer-sep">·</span>
        <a href="/create.html">Create</a>
        <span class="global-footer-sep">·</span>
        <a href="/explore.html">Explore</a>
      </div>
    </footer>
  `;

  // Insert header at top of body
  const headerElement = document.createElement('div');
  headerElement.innerHTML = headerHTML;
  document.body.insertBefore(headerElement.firstElementChild, document.body.firstChild);

  // Insert footer at bottom of body
  const footerElement = document.createElement('div');
  footerElement.innerHTML = footerHTML;
  document.body.appendChild(footerElement.firstElementChild);

  updateActiveNavLink();
  applyAdminConfig();
}

// ── Admin-controlled nav visibility + feature flags ────────────────────────
// Reads two public endpoints and applies them to the rendered page:
//   /api/nav-config — per-page { hidden, disabled } overrides for nav links
//   /api/flags      — { key: enabled } map consumed by [data-flag] elements
//   /api/auth/session — reveals the Admin link only to admins
// All best-effort: a fetch failure leaves the default (fully visible) nav.
async function applyAdminConfig() {
  applyNavConfig();
  applyFeatureFlags();
  revealAdminLink();
}

async function applyNavConfig() {
  try {
    const r = await fetch('/api/nav-config', { cache: 'no-store' });
    if (!r.ok) return;
    const { navigation } = await r.json();
    if (!navigation) return;
    document.querySelectorAll('.global-nav-link[data-nav-path]').forEach((link) => {
      const cfg = navigation[link.getAttribute('data-nav-path')];
      if (!cfg) return;
      if (cfg.hidden) {
        link.style.display = 'none';
        return;
      }
      if (cfg.disabled) {
        link.classList.add('nav-disabled');
        link.setAttribute('aria-disabled', 'true');
        link.removeAttribute('href');
        // setProperty(..., 'important') so the greying wins over any
        // .global-nav-link opacity rule in the stylesheet.
        link.style.setProperty('pointer-events', 'none', 'important');
        link.style.setProperty('opacity', '0.4', 'important');
        link.style.setProperty('cursor', 'not-allowed', 'important');
        link.title = 'Temporarily disabled by an administrator';
      }
    });
  } catch (e) { /* best-effort */ }
}

async function applyFeatureFlags() {
  try {
    const r = await fetch('/api/flags', { cache: 'no-store' });
    if (!r.ok) return;
    const { flags } = await r.json();
    if (!flags) return;
    // Expose for ad-hoc checks: window.LanternFlags.enabled('my_flag')
    window.LanternFlags = {
      map: flags,
      enabled: (key) => !!flags[key],
    };
    // [data-flag="key"]      → shown only when the flag is ENABLED
    // [data-flag-off="key"]  → shown only when the flag is DISABLED/absent
    document.querySelectorAll('[data-flag]').forEach((el) => {
      if (!flags[el.getAttribute('data-flag')]) el.style.display = 'none';
    });
    document.querySelectorAll('[data-flag-off]').forEach((el) => {
      if (flags[el.getAttribute('data-flag-off')]) el.style.display = 'none';
    });
    document.dispatchEvent(new CustomEvent('lantern-flags-ready', { detail: { flags } }));
  } catch (e) { /* best-effort */ }
}

async function revealAdminLink() {
  try {
    const r = await fetch('/api/auth/session', { cache: 'no-store' });
    if (!r.ok) return;
    const info = await r.json();
    if (info && info.role === 'admin') {
      document.querySelectorAll('[data-admin-only]').forEach((el) => { el.style.display = ''; });
    }
  } catch (e) { /* best-effort */ }
}

// Mark active nav link based on current page
function updateActiveNavLink() {
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  const navLinks = document.querySelectorAll('.global-nav-link');

  navLinks.forEach(link => {
    const href = link.getAttribute('href');
    const linkPage = href.split('/').pop();

    if (linkPage === currentPage ||
        (currentPage === '' && href === '/') ||
        (currentPage === 'index.html' && href === '/')) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });
}

// Theme toggle functionality
document.addEventListener('DOMContentLoaded', function() {
  const themeBtn = document.getElementById('global-theme-btn');
  if (themeBtn) {
    const savedTheme = localStorage.getItem('lantern-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    themeBtn.addEventListener('click', function() {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const newTheme = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('lantern-theme', newTheme);
      updateThemeIcon(newTheme);
    });
  }
});

function updateThemeIcon(theme) {
  const icon = document.querySelector('.theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSharedHeader);
} else {
  initializeSharedHeader();
}
