fix(profile): overhaul profile.html UX to match index / dream-chat and fix overlap (#2138)

The profile page forced its whole body into one non-scrolling screen
(`main{overflow:hidden}` + vertical centering + a squeezed two-column grid). On
some viewports the content collided — the reported overlap of the **Account ID**
cell and the "Connect multiple providers" note. Reworked the shell into a clean,
scrolling, card-based layout with stable vertical rhythm (fixed gaps instead of
`vh`-based clamps that collapsed), so nothing overlaps and the page breathes like
the home and chat surfaces. Also dropped the hardcoded `data-theme="dark"` in
favour of the same flash-free theme bootstrap as index.html, so the page now
respects the user's saved / system light-or-dark preference. Content, JS, and
API wiring are unchanged.
