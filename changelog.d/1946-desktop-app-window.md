Desktop app now launches as a standalone chromeless app window with NO console
window (#1946). build-desktop-exe.mjs flips the built exe's PE subsystem to GUI(2)
so double-click never pops a console; launcher.js redirects logs to
%LOCALAPPDATA%\unisona\logs\desktop.log. The launcher opens the UI in Edge/Chrome
`--app` mode (chromeless window, own taskbar icon, WebView2 engine already on
Windows — no bundled Chromium) with an isolated --user-data-dir, and closing the
window quits the app (waits on the app process, tears down the Core tree) — no
orphaned server. Falls back to default browser if no Edge/Chrome. Verified on
Windows: shortcut → no console → app window → HTTP 200 → close-window stops Core.
Strengthens Act (real desktop-app delivery).
