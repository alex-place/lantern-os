### Fixed

- trader: a logged-out visitor's trader page no longer asks for the AI trade list. The endpoint is trade-gated, so every guest page load put a 401 in the browser console for a list a guest does not have; signed-in traders load it exactly as before.
