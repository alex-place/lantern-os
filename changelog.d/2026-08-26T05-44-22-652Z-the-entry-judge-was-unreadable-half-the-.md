### Fixed

- **The entry judge (`#3390`) was unreadable half the time.** Of 18 journaled rows, 14
  were degraded; the claude provider scored **4× "unparseable" against 4 real verdicts**.
  "unparseable" means no `{...}` was found *at all* — the signature of a reply cut off
  before its closing brace, not a model refusing the format. `max_tokens` was **200**, and
  the verdicts that did land used 17–19 of the prompt's 20 allowed words: it was clipping
  its own answers mid-reason. Raised to 512, and `parseReply` now recovers a fenced block,
  an object missing its opening brace, and a reply truncated mid-string.
  **Live replay of all 9 real journaled entries: 9 verdicts / 9 attempts** (was 4/9).
- An assistant prefill of `{` was tried first as a stronger JSON guarantee. The API
  refuses it on this model — `HTTP 400, "This model does not support assistant message
  prefill"` — which only a call to the real endpoint revealed. Both facts are pinned by
  test so the next person does not re-attempt it.

### Known, not fixed here

- **The local Σ₀ provider is still down** — 9× `fetch failed`, nothing listening on
  `:11434`. Ollama is installed at `%LOCALAPPDATA%\Programs\Ollama` but not running, and
  `ollama list` did not return. The judge's two-provider design is therefore running on
  one provider; its degraded rows are honest and should stay until the serve is up.
- **No verdict has been scored against an outcome yet.** `experiments/entry_judge_score.js`
  exists for exactly that. Until it says approved entries beat rejected ones, the judge
  has earned nothing — a readable judge is not a useful one.
