feat(dist): add winget manifests (`winget install Unisona`) + a cert-agnostic
code-signing seam in release.yml. Signing is guarded on CODE_SIGN_PFX_BASE64 (no-op
until set). Note: SignPath Foundation's free OSS signing does NOT apply — the repo is
proprietary-licensed, so the warning-free path is the Microsoft Store (re-signs free)
or a paid OV cert via the new signing step.
