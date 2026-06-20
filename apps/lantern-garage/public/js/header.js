/**
 * Unified Keystone OS Header Component
 * Provides consistent light/dark mode toggle + navigation across all pages
 *
 * Usage: Add to your HTML <head>:
 *   <script src="/js/header.js"></script>
 *   <link rel="stylesheet" href="/css/header.css">
 */

function initializeHeader() {
  // Detect current page for active nav link
  const currentPage = window.location.pathname.split('/').pop() || 'dream-chat.html';

  // Create header HTML
  const headerHtml = `
    <nav class="site-nav">
      <a class="nav-brand" href="/trader-dashboard.html">
        <img src="/mandala.svg" alt="" aria-hidden="true" style="width:24px;height:24px;vertical-align:middle">
        <span style="font-size:18px;font-weight:600">Keystone OS</span>
      </a>
      <div class="nav-links">
        <a href="/dream-chat.html" class="nav-link ${currentPage === 'dream-chat.html' ? 'active' : ''}" style="font-size:16px;padding:12px 16px">⚙️ Work</a>
        <a href="/trader-dashboard.html" class="nav-link ${currentPage === 'trader-dashboard.html' ? 'active' : ''}" style="font-size:16px;padding:12px 16px">📈 Trade</a>
        <a href="/create.html" class="nav-link ${currentPage === 'create.html' ? 'active' : ''}" style="font-size:16px;padding:12px 16px">✏️ Create</a>
      </div>
      <div class="nav-actions">
        <button class="nav-btn" id="theme-toggle" aria-label="Toggle light/dark mode" title="Light/Dark Mode">🌙</button>
        <a href="/api-keys-settings.html" class="nav-btn ${currentPage === 'api-keys-settings.html' ? 'active' : ''}" aria-label="API Keys" title="Settings">⚙️</a>
      </div>
    </nav>
  `;

  // Insert header at the top of body
  const headerDiv = document.createElement('div');
  headerDiv.innerHTML = headerHtml;
  document.body.insertBefore(headerDiv.firstElementChild, document.body.firstChild);

  // Initialize theme toggle
  initializeThemeToggle();
}

function initializeThemeToggle() {
  const themeToggle = document.getElementById('theme-toggle');
  if (!themeToggle) return;

  // Load saved theme preference
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeToggleIcon(savedTheme);

  // Theme toggle click handler
  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeToggleIcon(newTheme);
  });
}

function updateThemeToggleIcon(theme) {
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.textContent = theme === 'dark' ? '🌙' : '☀️';
  }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeHeader);
} else {
  initializeHeader();
}

// Export for manual use
window.LanternHeader = {
  initialize: initializeHeader,
  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    updateThemeToggleIcon(theme);
  },
};
