"""
Tests for HFF Ed25519 private-key-at-rest encryption (#1740).

save_keypair must encrypt the private key when a passphrase is configured
(argument or HFF_KEY_PASSPHRASE env), warn when it is not, and round-trip
through load_keypair either way.
"""

import os
import sys
import warnings

import pytest

# src/hff-api has a hyphen, so it is not an importable package name; add it to
# the path directly the way the app entrypoints do.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "hff-api"))

cp = pytest.importorskip("cryptographic_proof")


def _keys():
    return cp.generate_keypair()


def test_explicit_passphrase_encrypts_and_roundtrips(tmp_path):
    priv, pub = _keys()
    pp = tmp_path / "k.pem"
    pub_p = tmp_path / "k_pub.pem"
    cp.save_keypair(priv, pub, str(pp), str(pub_p), passphrase="s3cret")

    assert b"ENCRYPTED" in pp.read_bytes()
    priv2, pub2 = cp.load_keypair(str(pp), str(pub_p), passphrase="s3cret")
    signed = cp.sign_record({"e": 1}, priv2)
    assert cp.verify_record(signed, pub2)


def test_wrong_passphrase_rejected(tmp_path):
    priv, pub = _keys()
    pp = tmp_path / "k.pem"
    pub_p = tmp_path / "k_pub.pem"
    cp.save_keypair(priv, pub, str(pp), str(pub_p), passphrase="right")
    with pytest.raises((ValueError, TypeError)):
        cp.load_keypair(str(pp), str(pub_p), passphrase="wrong")


def test_env_var_passphrase(tmp_path, monkeypatch):
    monkeypatch.setenv("HFF_KEY_PASSPHRASE", "envpass")
    priv, pub = _keys()
    pp = tmp_path / "k.pem"
    pub_p = tmp_path / "k_pub.pem"
    cp.save_keypair(priv, pub, str(pp), str(pub_p))  # no explicit passphrase
    assert b"ENCRYPTED" in pp.read_bytes()
    # env var also drives decryption
    cp.load_keypair(str(pp), str(pub_p))


def test_unencrypted_path_warns_and_still_loads(tmp_path, monkeypatch):
    monkeypatch.delenv("HFF_KEY_PASSPHRASE", raising=False)
    priv, pub = _keys()
    pp = tmp_path / "k.pem"
    pub_p = tmp_path / "k_pub.pem"
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        cp.save_keypair(priv, pub, str(pp), str(pub_p))
    assert any(issubclass(w.category, UserWarning) for w in caught)
    assert b"ENCRYPTED" not in pp.read_bytes()
    # backwards-compatible: unencrypted keys still load with no passphrase
    cp.load_keypair(str(pp), str(pub_p))
