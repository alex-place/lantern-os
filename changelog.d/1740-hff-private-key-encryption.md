fix(security): encrypt HFF Ed25519 private key at rest (#1740)

`save_keypair` in `src/hff-api/cryptographic_proof.py` wrote the node's Ed25519
private key with `NoEncryption()`. It now encrypts the key with
`BestAvailableEncryption` when a passphrase is configured (via the new
`passphrase=` argument or the `HFF_KEY_PASSPHRASE` env var), warns loudly when
no passphrase is set instead of silently writing plaintext, and writes the
private file with owner-only (0600) permissions on POSIX. `load_keypair` reads
the same passphrase source. Backwards-compatible: existing unencrypted keys
still load. Covered by `tests/test_hff_key_encryption.py`.
