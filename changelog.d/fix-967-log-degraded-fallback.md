### Fixed
- Log swallowed cloud-provider errors in auto-cascade mode before degraded-local fallback (#967). Each cloud provider (gemini, anthropic, openai, xai/grok) now emits `console.warn("[stream-chat] <provider> auto-cascade failed …")` when it fails in auto-mode and falls through to the next provider, making the root cause of silent degradation (issue #965) visible in server logs.
