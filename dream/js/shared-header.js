// ── Shared Global Header/Footer ──────────────────────────────────────────
// Injects consistent header into all pages

function initializeSharedHeader() {
  // Create header HTML
  const headerHTML = `
    <nav class="global-nav">
      <div class="global-nav-inner">
        <a class="global-nav-brand" href="/">
          <img src="/mandala.svg" alt="" aria-hidden="true">
          <span>Lantern OS</span>
        </a>

        <div class="global-nav-center">
          <a href="/dream-chat.html" class="global-nav-link">Journal</a>
          <a href="/trader-dashboard.html" class="global-nav-link">Trader</a>
          <a href="/create.html" class="global-nav-link">Create</a>
          <a href="/explore.html" class="global-nav-link">Explore</a>
          <a href="/knowledgecenter.html" class="global-nav-link">Help</a>
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
          Lantern OS
        </span>
        <span class="global-footer-sep">·</span>
        <a href="/">Home</a>
        <span class="global-footer-sep">·</span>
        <a href="/dream-chat.html">Journal</a>
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
