### Fixed

- faq.html is now public: the Knowledge Center hero links it under 'no account or API key required', but it was gated and 302'd guests to /auth.html. Added /faq.html to PUBLIC_PAGES (routes/pages.js) and the auth-gate.js PUBLIC allowlist — same un-gate applied to pricing in #2610 (#3161).
