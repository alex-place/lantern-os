#!/usr/bin/env python3
"""
Provides cryptographic signing and audit logging.

Signatures prove a record was created by the holder of a specific private key.
The audit log is append-only in software; physical database access can still
modify it. Courts determine admissibility; this software does not make that
determination.
"""

import hashlib
import json
import os
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.exceptions import InvalidSignature

# ---------------------------------------------------------------------------
# Key management
# ---------------------------------------------------------------------------


def generate_keypair() -> Tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    """Generate a fresh Ed25519 private/public key pair."""
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    return private_key, public_key


def save_keypair(
    private_key: Ed25519PrivateKey,
    public_key: Ed25519PublicKey,
    private_path: str,
    public_path: str,
) -> None:
    """Persist an Ed25519 key pair to PEM files.

    The private key is written **unencrypted**.  In production you would
    encrypt it with a passphrase; this is a teaching implementation.
    """
    priv_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    pub_bytes = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    os.makedirs(os.path.dirname(private_path) or ".", exist_ok=True)
    os.makedirs(os.path.dirname(public_path) or ".", exist_ok=True)

    with open(private_path, "wb") as f:
        f.write(priv_bytes)
    with open(public_path, "wb") as f:
        f.write(pub_bytes)


def load_keypair(
    private_path: str, public_path: str
) -> Tuple[Ed25519PrivateKey, Ed25519PublicKey]:
    """Load an Ed25519 key pair from PEM files."""
    with open(private_path, "rb") as f:
        private_key = serialization.load_pem_private_key(f.read(), password=None)
    with open(public_path, "rb") as f:
        public_key = serialization.load_pem_public_key(f.read())

    if not isinstance(private_key, Ed25519PrivateKey):
        raise TypeError("Private key is not Ed25519")
    if not isinstance(public_key, Ed25519PublicKey):
        raise TypeError("Public key is not Ed25519")

    return private_key, public_key


# ---------------------------------------------------------------------------
# Record signing
# ---------------------------------------------------------------------------


def _canonical(record: dict) -> bytes:
    """Produce a canonical byte representation of a dict for signing."""
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")


@dataclass
class SignedRecord:
    """A record bundled with its Ed25519 signature."""

    record: dict
    signature: bytes  # raw Ed25519 signature (64 bytes)
    public_key_bytes: bytes  # DER-encoded public key for verification
    timestamp_utc: str

    def to_dict(self) -> dict:
        """Serialise to a JSON-safe dict (hex-encoding binary fields)."""
        return {
            "record": self.record,
            "signature_hex": self.signature.hex(),
            "public_key_hex": self.public_key_bytes.hex(),
            "timestamp_utc": self.timestamp_utc,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "SignedRecord":
        return cls(
            record=d["record"],
            signature=bytes.fromhex(d["signature_hex"]),
            public_key_bytes=bytes.fromhex(d["public_key_hex"]),
            timestamp_utc=d["timestamp_utc"],
        )


def sign_record(record: dict, private_key: Ed25519PrivateKey) -> SignedRecord:
    """Sign *record* with the given Ed25519 private key.

    Returns a ``SignedRecord`` containing the original data, the raw
    signature, the corresponding public key (for verification), and an
    ISO-8601 UTC timestamp.
    """
    canonical = _canonical(record)
    signature = private_key.sign(canonical)

    pub_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    return SignedRecord(
        record=record,
        signature=signature,
        public_key_bytes=pub_bytes,
        timestamp_utc=datetime.now(timezone.utc).isoformat(),
    )


def verify_record(signed_record: SignedRecord, public_key: Ed25519PublicKey) -> bool:
    """Verify the Ed25519 signature on a ``SignedRecord``.

    Returns ``True`` if the signature is valid, ``False`` otherwise.
    """
    canonical = _canonical(signed_record.record)
    try:
        public_key.verify(signed_record.signature, canonical)
        return True
    except InvalidSignature:
        return False


# ---------------------------------------------------------------------------
# Merkle tree
# ---------------------------------------------------------------------------


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class MerkleTree:
    """A simple binary Merkle tree over a list of records (dicts).

    Leaves are SHA-256 hashes of canonical JSON representations.
    """

    def __init__(self, records: List[dict]) -> None:
        if not records:
            raise ValueError("MerkleTree requires at least one record")
        self.records = list(records)
        self.leaves: List[str] = [_sha256(_canonical(r)) for r in self.records]
        self._tree: List[List[str]] = self._build()

    def _build(self) -> List[List[str]]:
        """Build the tree bottom-up.  Returns list of levels (0 = leaves)."""
        levels: List[List[str]] = [self.leaves[:]]
        current = self.leaves[:]
        while len(current) > 1:
            if len(current) % 2 == 1:
                current.append(current[-1])  # duplicate last
            next_level = []
            for i in range(0, len(current), 2):
                combined = (current[i] + current[i + 1]).encode()
                next_level.append(_sha256(combined))
            levels.append(next_level)
            current = next_level
        return levels

    @property
    def root(self) -> str:
        """The Merkle root hash."""
        return self._tree[-1][0]

    def get_proof(self, index: int) -> List[Tuple[str, str]]:
        """Return an inclusion proof for the leaf at *index*.

        Each element is ``(hash, side)`` where side is ``'left'`` or
        ``'right'``, indicating which side the sibling sits on.
        """
        if index < 0 or index >= len(self.leaves):
            raise IndexError(f"Index {index} out of range [0, {len(self.leaves)})")

        proof: List[Tuple[str, str]] = []
        idx = index
        for level in self._tree[:-1]:
            padded = level[:]
            if len(padded) % 2 == 1:
                padded.append(padded[-1])

            if idx % 2 == 0:
                sibling = padded[idx + 1]
                proof.append((sibling, "right"))
            else:
                sibling = padded[idx - 1]
                proof.append((sibling, "left"))
            idx //= 2
        return proof

    @staticmethod
    def verify_proof(record: dict, proof: List[Tuple[str, str]], root: str) -> bool:
        """Verify a Merkle inclusion proof for *record* against *root*."""
        current = _sha256(_canonical(record))
        for sibling_hash, side in proof:
            if side == "left":
                combined = (sibling_hash + current).encode()
            else:
                combined = (current + sibling_hash).encode()
            current = _sha256(combined)
        return current == root


# ---------------------------------------------------------------------------
# Append-only audit log (SQLite)
# ---------------------------------------------------------------------------

_AUDIT_DB = os.environ.get("AUDIT_DB_PATH", "./data/audit.db")


class AuditLog:
    """Append-only, hash-chain-linked audit log backed by SQLite.

    Each entry stores a SHA-256 hash of (previous_hash || canonical_record),
    forming a tamper-evident chain.  Note: this is tamper-*evident*, not
    tamper-*proof* — anyone with write access to the SQLite file can modify
    it.  The chain lets you detect such modifications.
    """

    def __init__(self, db_path: str = _AUDIT_DB) -> None:
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_entries (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                record_json     TEXT    NOT NULL,
                record_hash     TEXT    NOT NULL,
                previous_hash   TEXT    NOT NULL,
                chain_hash      TEXT    NOT NULL,
                created_at      TEXT    NOT NULL
            )
        """
        )
        conn.commit()
        conn.close()

    def _last_chain_hash(self) -> str:
        """Return the chain_hash of the most recent entry, or a zero hash."""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute(
            "SELECT chain_hash FROM audit_entries ORDER BY id DESC LIMIT 1"
        )
        row = c.fetchone()
        conn.close()
        return row[0] if row else ("0" * 64)

    def append(self, record: dict) -> int:
        """Append *record* to the audit log.  Returns the new entry ID."""
        canonical = _canonical(record)
        record_hash = _sha256(canonical)
        previous_hash = self._last_chain_hash()
        chain_hash = _sha256((previous_hash + record_hash).encode())
        now = datetime.now(timezone.utc).isoformat()

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute(
            """INSERT INTO audit_entries
               (record_json, record_hash, previous_hash, chain_hash, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (canonical.decode("utf-8"), record_hash, previous_hash, chain_hash, now),
        )
        entry_id = c.lastrowid
        conn.commit()
        conn.close()
        return entry_id

    def verify_chain(self) -> Tuple[bool, int]:
        """Walk the chain and verify every link.

        Returns ``(is_valid, entries_checked)``.
        """
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute(
            "SELECT id, record_json, record_hash, previous_hash, chain_hash "
            "FROM audit_entries ORDER BY id"
        )
        rows = c.fetchall()
        conn.close()

        prev = "0" * 64
        for row in rows:
            _id, record_json, record_hash, previous_hash, chain_hash = row
            if previous_hash != prev:
                return False, _id
            expected_record_hash = _sha256(record_json.encode("utf-8"))
            if record_hash != expected_record_hash:
                return False, _id
            expected_chain = _sha256((previous_hash + record_hash).encode())
            if chain_hash != expected_chain:
                return False, _id
            prev = chain_hash

        return True, len(rows)

    def entries(self, limit: int = 100) -> List[dict]:
        """Return the most recent entries (newest first)."""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute(
            "SELECT id, record_json, chain_hash, created_at "
            "FROM audit_entries ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        rows = c.fetchall()
        conn.close()
        return [
            {
                "id": r[0],
                "record": json.loads(r[1]),
                "chain_hash": r[2],
                "created_at": r[3],
            }
            for r in rows
        ]


# ---------------------------------------------------------------------------
# Module self-test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Quick smoke test
    priv, pub = generate_keypair()
    rec = {"event": "test", "value": 42}
    signed = sign_record(rec, priv)
    assert verify_record(signed, pub), "Signature verification failed"

    tree = MerkleTree([{"a": 1}, {"b": 2}, {"c": 3}])
    proof = tree.get_proof(1)
    assert MerkleTree.verify_proof({"b": 2}, proof, tree.root), "Merkle proof failed"

    log = AuditLog(db_path="./data/audit_test.db")
    log.append({"action": "test_entry"})
    valid, count = log.verify_chain()
    assert valid, "Audit chain verification failed"

    print("[OK] Ed25519 signing works")
    print("[OK] Merkle tree works")
    print(f"[OK] Audit log works ({count} entries verified)")
