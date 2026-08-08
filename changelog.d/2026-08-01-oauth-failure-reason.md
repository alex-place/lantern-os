### Fixed
- **A failed OAuth sign-in now says what went wrong.** "Sign-in didn't complete.
  Please try again. (google)" was the same message for five very different faults —
  a rejected code, wrong client credentials, an unreachable userinfo endpoint, a
  storage failure, or a profile-linking error — so neither the user nor the log
  could tell them apart. The callback now classifies the exception into a stable
  `reason` code, surfaces a plain-English explanation on the sign-in page, and logs
  the full detail server-side with the resolved `redirect_uri` and a truncated
  stack. The reason is a fixed code, never the raw upstream message, so provider
  error bodies (which can carry tokens/PII) never reach a URL.
