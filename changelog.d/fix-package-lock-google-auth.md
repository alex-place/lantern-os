### Build: sync package-lock with google-auth-library (unbreaks `npm ci` / CI)

- The Vertex AI work added `google-auth-library@^9.15.0` to `apps/lantern-garage/package.json` but never regenerated `package-lock.json`, so `npm ci` failed repo-wide ("Missing: google-auth-library from lock file") — breaking the "Lint & validate" job and every npm-ci-dependent CI check on all PRs. Regenerated the lock (lock-only) to include google-auth-library and its transitive deps; CI's `npm ci` is satisfied again.
