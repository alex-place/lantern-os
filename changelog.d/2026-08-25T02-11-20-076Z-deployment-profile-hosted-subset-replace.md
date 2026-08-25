### Fixed

- deployment-profile hosted subset: replaced the dangling profile.html entry (retired → 302s to settings.html) with settings.html, and fixed the test's stale dream-chat.html reference (renamed to chat.html in #2751). The dangling entry meant a logged-in user on a CLOUD instance who opened their account/profile got 302'd to /settings.html — which was NOT in the hosted allowlist — so the account page was unreachable on the hosted tier; it is now served. The test had been RED on master since the #2751 rename.
