### Chat: Gemini model chain survives transient 503s instead of erroring out

- The Gemini fallback chain only advanced to the next model on `429`/quota. A transient `503` "high demand" (frequent on `gemini-2.5/3.x-flash`) on a middle model aborted the whole chain before it could reach a working model, surfacing a hard error to the user. Transient `5xx` and request timeouts are now treated the same as `429` — try the next model in the chain — while auth/4xx still hard-fail. Fixes #1234.
