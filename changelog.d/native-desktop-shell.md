feat(desktop): ship a native desktop app instead of launching the Edge browser. The
Windows app is now a .NET WPF + WebView2 shell (Unisona.exe) — a real native window
(own title bar, taskbar entry, dark chrome, no address bar, no msedge.exe) that boots
the unmodified Core via `unisona-core.exe --embed` and hosts the cockpit in WebView2.
The installer builds and packages both (shell + Core SEA); verified end-to-end
(install → launch → HTTP 200, zero node.exe). Amends ADR-0014 G5.
