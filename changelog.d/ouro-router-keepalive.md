### Chat: keep the Ouro router model warm (OURO_ROUTER_KEEP_ALIVE)

- The Ouro Auto-mode intent router (`lib/ouro-router.js`) now sends Ollama `keep_alive: "30m"` on its classification call. Without it, Ollama unloads the router model after its default ~5m idle TTL, so on a low-traffic server the next Auto turn paid a cold model-load that blew the timeout and fell back to keywords every time — making `OURO_ROUTER=1` effectively a no-op in production. Tunable via `OURO_ROUTER_KEEP_ALIVE`.
