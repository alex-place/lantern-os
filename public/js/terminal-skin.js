/* terminal-skin.js — opt-in "Terminal" (phosphor-CRT) skin toggle for dream-chat.
 *
 * The skin is a scoped CSS layer (css/dream-chat-terminal.css) gated on the
 * html[data-skin="terminal"] attribute. This file is only the switch:
 *   - toggleSkin()  flips the attribute + persists the choice
 *   - sync()        keeps the ▚ button's pressed state in step
 * The choice is restored FROM localStorage by a tiny inline script in the page
 * <head> (before paint, to avoid a flash of the default theme), so this file
 * just wires the button and reflects state.
 */
(function () {
  var KEY = 'keystone-skin';
  function on() { return document.documentElement.getAttribute('data-skin') === 'terminal'; }

  window.toggleSkin = function () {
    var wasOn = on();
    if (wasOn) document.documentElement.removeAttribute('data-skin');
    else document.documentElement.setAttribute('data-skin', 'terminal');
    try { localStorage.setItem(KEY, wasOn ? 'default' : 'terminal'); } catch (e) {}
    sync();
  };

  function sync() {
    var b = document.getElementById('skin-toggle');
    if (b) b.setAttribute('aria-pressed', on() ? 'true' : 'false');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
  else sync();
})();
