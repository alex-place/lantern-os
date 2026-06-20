# Admin Feature Flags & Navigation Visibility

An admin-only control surface for **feature flags** (named on/off switches) and
**per-page navigation visibility** (hide or disable nav links across the site).
It is persisted, applies on every page, and is enforced both in the browser and
on the server.

> **Access:** the config page and all write APIs are **admin-only**. On the local
> dev server (port 4178) and on a loopback connection with `LANTERN_LOCAL_ADMIN=1`,
> the owner is treated as admin automatically. Remote users need the `admin` role.

---

## The config page — `/admin-flags.html`

Open **Admin → Feature Flags** (the **Admin** link appears in the nav only for
admins). The page has two sections:

### Navigation visibility
Each navigable page has two independent toggles:

| Toggle | Effect on the nav link | Effect on the page itself |
|--------|------------------------|---------------------------|
| **Hidden** | Link removed from the nav | Page still reachable by direct URL |
| **Disabled** | Link greyed out, un-clickable, tooltip | Page **blocked** for non-admins (admins keep preview access) |

Use **Hidden** to tidy the nav; use **Disabled** as a temporary kill-switch for a
page you want taken out of service.

### Feature flags
Add a flag (key + optional label/description), toggle it on/off, or delete it.
Keys are normalized to lowercase `a–z 0–9 . _ -` (e.g. `New Dashboard!` → `newdashboard`).

---

## Using a feature flag

Flags are exposed to every page through `auth-gate.js`. Two ways to consume them:

**1. Declarative — show/hide elements by flag:**
```html
<!-- shown only when the flag is ENABLED -->
<div data-flag="beta_banner">🎉 Beta features are live</div>

<!-- shown only when the flag is DISABLED / absent -->
<div data-flag-off="beta_banner">Coming soon</div>
```

**2. Imperative — check in JavaScript:**
```js
if (window.LanternFlags && window.LanternFlags.enabled('beta_banner')) {
  // …enable the beta code path
}
// or listen for readiness:
document.addEventListener('lantern-flags-ready', (e) => {
  console.log(e.detail.flags); // { beta_banner: true, … }
});
```

Server-side, use `isFlagEnabled('beta_banner')` from `lib/feature-flags.js`.

---

## How it's wired

- **Store:** `apps/lantern-garage/lib/feature-flags.js` — persists to
  `data/admin/feature-flags.json` (cached, latest-wins). Holds the flag map and a
  per-page `{ hidden, disabled }` navigation map. The canonical nav page list
  lives in `NAV_PAGES` and must stay in step with the links in each page's nav.
- **Client wiring:** `apps/lantern-garage/public/js/auth-gate.js` (loaded on every
  page) fetches the config and applies it by **link href**, so it covers each
  page's inline `<nav class="site-nav">` automatically — not a single header
  component. It also injects the **Admin** link for admins, reusing the session it
  already fetches.
- **Server enforcement:** `apps/lantern-garage/routes/pages.js` blocks any page
  flagged **Disabled** for non-admins (returns a friendly "temporarily disabled"
  page; admins still get through for preview).

---

## API reference

**Public reads** (consumed by the client on every page):

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/flags` | `{ flags: { key: enabledBool } }` |
| `GET` | `/api/nav-config` | `{ navigation: { path: { hidden, disabled } } }` |

**Admin-only** (403 for non-admins):

| Method | Path | Body | Action |
|--------|------|------|--------|
| `GET` | `/api/admin/config` | — | Full config (flags + navigation, with metadata) |
| `PUT` | `/api/admin/flags` | `{ key, label?, description?, enabled? }` | Create/update a flag |
| `DELETE` | `/api/admin/flags/:key` | — | Remove a flag |
| `PUT` | `/api/admin/nav` | `{ path, hidden?, disabled? }` | Set a page's nav visibility |

Example — disable the Trader nav link as a kill-switch:
```bash
curl -X PUT http://127.0.0.1:4178/api/admin/nav \
  -H 'Content-Type: application/json' \
  -d '{"path":"/trader-dashboard.html","disabled":true}'
```

---

## Notes

- **Hidden ≠ secured.** Hiding a link only removes it from the nav; the page stays
  reachable by URL. Use **Disabled** (server-enforced) or a role/entitlement gate
  in `routes/pages.js` when access must actually be restricted.
- Flag and nav state are runtime data (`data/admin/feature-flags.json`), not code —
  changes take effect immediately, no deploy required.
