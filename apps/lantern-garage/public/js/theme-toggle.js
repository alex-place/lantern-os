// Shared theme toggle logic for all unisona.ai pages
(function() {
  const stored = localStorage.getItem('lantern-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = stored ? stored === 'dark' : prefersDark;
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const btn = document.getElementById('theme-toggle');
  // Skip legacy emoji buttons; SVG-icon navs show sun/moon via CSS (data-theme).
  if (btn && !btn.querySelector('svg')) btn.textContent = isDark ? '☀️' : '🌙';
})();

function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('lantern-theme', next);
  const btn = document.getElementById('theme-toggle');
  if (btn && !btn.querySelector('svg')) btn.textContent = next === 'dark' ? '☀️' : '🌙';
}
