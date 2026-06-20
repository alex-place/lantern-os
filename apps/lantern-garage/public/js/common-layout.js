// Common Header and Footer injection
// Include this script in any page to auto-inject common header/footer

(function() {
  // Get current page info
  const path = window.location.pathname;
  const isDreamChat = path.includes('dream-chat');
  const isDreamJournal = path.includes('dream-journal');
  const isFlourishing = path.includes('flourishing');

  // Determine page title and logo
  let pageTitle = 'Keystone OS';
  let pageSubtitle = 'private · local';
  let pageLogo = '🔮';

  if (isDreamChat) {
    pageTitle = 'Dream Journal';
    pageSubtitle = 'write & reflect';
    pageLogo = '💭';
  } else if (isDreamJournal) {
    pageTitle = 'Full Journal';
    pageSubtitle = 'archive & synthesis';
    pageLogo = '📓';
  } else if (isFlourishing) {
    pageTitle = 'How\'s the World Doing?';
    pageSubtitle = 'convergence metrics';
    pageLogo = '🌍';
  }

  // Create common header
  function createHeader() {
    return `
      <header class="common-header">
        <div class="header-left">
          <a href="/" class="back-link" title="Back to home">←</a>
          <div class="header-logo">${pageLogo}</div>
          <div class="header-title">
            <h1>${pageTitle}</h1>
            <div class="subtitle">${pageSubtitle}</div>
          </div>
        </div>
        <div class="header-nav">
          <button class="header-theme-toggle" id="theme-toggle-common" title="Toggle light / dark mode" onclick="toggleTheme()">
            <span class="mandala-icon spin-slow"></span>
          </button>
          <div class="header-status">
            <span class="status-dot" id="status-indicator"></span>
            <span id="status-text">connecting</span>
          </div>
        </div>
      </header>
    `;
  }

  // Create common footer
  function createFooter() {
    return `
      <footer class="common-footer">
        <div class="footer-left">
          <span>© 2025 Keystone OS</span>
        </div>
        <div class="footer-right">
          <a href="/repo/README.md" target="_blank" class="footer-link">Docs</a>
          <a href="https://github.com/alex-place/lantern-os" target="_blank" class="footer-link">GitHub</a>
          <a href="/repo/CHANGELOG.MD" target="_blank" class="footer-link">Changelog</a>
        </div>
      </footer>
    `;
  }

  // Inject header and footer
  document.addEventListener('DOMContentLoaded', function() {
    // Don't inject on home page (index.html)
    if (path === '/' || path === '/index.html') {
      return;
    }

    // Find or create page wrapper
    let pageWrapper = document.querySelector('.page-with-layout');
    if (!pageWrapper) {
      // Wrap existing body content
      const body = document.body;
      pageWrapper = document.createElement('div');
      pageWrapper.className = 'page-with-layout';

      // Move all body children into wrapper
      while (body.firstChild) {
        pageWrapper.appendChild(body.firstChild);
      }
      body.appendChild(pageWrapper);
    }

    // Inject header at top
    const headerDiv = document.createElement('div');
    headerDiv.innerHTML = createHeader();
    pageWrapper.insertBefore(headerDiv.firstElementChild, pageWrapper.firstChild);

    // Wrap content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'page-content';

    // Find app or main content container
    let appContainer = document.querySelector('.app') ||
                       document.querySelector('main') ||
                       document.querySelector('.page');

    if (appContainer && appContainer !== pageWrapper) {
      contentDiv.appendChild(appContainer);
      pageWrapper.insertBefore(contentDiv, pageWrapper.lastChild);
    }

    // Inject footer at bottom
    const footerDiv = document.createElement('div');
    footerDiv.innerHTML = createFooter();
    pageWrapper.appendChild(footerDiv.firstElementChild);

    // Link up theme toggle
    const themeBtns = document.querySelectorAll('#theme-toggle, #theme-toggle-common');
    themeBtns.forEach(btn => {
      if (btn.onclick === null || btn.onclick.toString().includes('toggleTheme')) {
        btn.onclick = toggleTheme;
      }
    });
  });

  // Theme toggle function (ensure it exists)
  window.toggleTheme = window.toggleTheme || function() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('lantern-theme', next);
  };
})();
