fix(nav): restore the profile / sign-in icon on the home page

The global nav (site-chrome.js) always ships a `#profile-btn`, but auth-gate.js
hid it for guests and only injected a fallback sign-in button when NO profile
button existed — so on `/` (and every site-chrome page) a logged-out visitor saw
no login affordance at all. Repurpose the existing profile button into a sign-in
link for guests (→ `/auth.html?returnTo=…`) instead of hiding it, and restore its
`/profile.html` destination for authenticated users on re-check.

Improves Act (users can actually reach login from the home page). Verified in the
preview: guest branch renders a visible "Sign in" icon; authed branch renders the
profile icon.
