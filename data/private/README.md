# Private PIID House

This folder is a policy stub only.

Raw PIID, PII, patient-style context, private social/feed exports, private wallet identifiers, payment identifiers, credentials, and screenshots that reveal private people or accounts must stay local and encrypted.

Do not commit raw private data to Git.

Recommended local-only paths inside this repo (gitignored):

```text
C:\tmp\lantern-os\data\private\piid-vault\
C:\tmp\lantern-os\data\private\patient-packets\
```

Recommended rules:

- encrypt at rest using an OS-backed vault or age/sops-style encrypted files;
- store only redacted summaries in committed reports;
- record hashes/manifests for private files only when needed;
- keep source URLs, capture dates, permission state, and evidence class in redacted metadata;
- never store payment credentials, Apple Pay tokens, PayPal secrets, card data, seed phrases, or government identifiers in this repo.

Evidence class for private operator material:

```text
operator_private_context
```

Default decision:

```text
internal_only_hold_until_explicit_release
```
