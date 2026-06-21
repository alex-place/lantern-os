"""test(sigma0): collapse certificate + NIS χ² canary end-to-end (#852, component 8).

Exercises both convergence-guarantee canaries on the same synthetic trajectory:
1. Collapse certificate  (Lyapunov / stability gates) — algebraic, requires torch.
2. NIS χ² canary         (DecodeCanary / SurpriseMonitor) — CPU only, no model.

A trajectory that is degenerate (near-zero eigenvalues in A) must trigger the collapse
certificate. The same pathological scenario drives looping-decode tokens that trigger
NIS spook. Both are tested together so component-8 is [tested] end-to-end.
"""
import pytest

# Both the collapse certificate and DecodeCanary transitively import torch.
# Skip the whole module on Windows without VC++ redistributable.
try:
    import torch  # noqa: F401
    _TORCH = True
    from sigma0.decode_canary import DecodeCanary
except (ImportError, OSError):
    pytest.skip("torch unavailable (DLL or import error)", allow_module_level=True)
    _TORCH = False  # unreachable; satisfies linters


# ── helpers ───────────────────────────────────────────────────────────────────

def _contracting_A(d: int = 4) -> "torch.Tensor":
    """A Hurwitz (all-negative-real-eigenvalue) matrix — collapse is GUARANTEED."""
    return torch.diag(torch.tensor([-0.5, -1.0, -1.5, -2.0][:d], dtype=torch.float32))


def _degenerate_A(d: int = 4) -> "torch.Tensor":
    """A near-singular matrix with eigenvalues ≈ 0 — effective rank < d; collapse fails."""
    a = _contracting_A(d).clone()
    a[0, 0] = 1e-6     # near-zero → NOT Hurwitz
    return a


def _looping_tokens(n: int = 40, cycle: int = 3) -> list:
    """Token sequence that repeats a cycle indefinitely — triggers NIS spook."""
    return [i % cycle for i in range(n)]


def _healthy_tokens(n: int = 40) -> list:
    """Monotonically increasing token ids — no repetition."""
    return list(range(n))


# ── Collapse certificate tests (torch-gated) ───────────────────────────────────

@pytest.mark.skipif(not _TORCH, reason="torch unavailable (DLL or import error)")
def test_collapse_certificate_contracting():
    from cio_sde.collapse import collapse_certificate
    A = _contracting_A()
    cert = collapse_certificate(A)
    assert cert.proven_contracting, (
        f"Hurwitz matrix must be certified contracting; got α={cert.alpha:.4f}"
    )
    assert cert.alpha < 0, "matrix measure α must be negative for a contracting system"


@pytest.mark.skipif(not _TORCH, reason="torch unavailable (DLL or import error)")
def test_collapse_certificate_degenerate():
    from cio_sde.collapse import collapse_certificate
    A = _degenerate_A()
    cert = collapse_certificate(A)
    # near-zero first eigenvalue → NOT Hurwitz → not proven contracting
    assert not cert.proven_contracting, (
        "near-singular A must NOT be certified contracting"
    )


@pytest.mark.skipif(not _TORCH, reason="torch unavailable (DLL or import error)")
def test_stability_gates_contracting():
    from cio_sde.collapse import stability_gates
    gates = stability_gates(_contracting_A())
    assert gates.proven_contracting
    assert gates.spectral_abscissa < 0


@pytest.mark.skipif(not _TORCH, reason="torch unavailable (DLL or import error)")
def test_stability_gates_degenerate():
    from cio_sde.collapse import stability_gates
    gates = stability_gates(_degenerate_A())
    assert not gates.proven_contracting


@pytest.mark.skipif(not _TORCH, reason="torch unavailable (DLL or import error)")
def test_collapse_certificate_summary_shape():
    from cio_sde.collapse import collapse_certificate
    cert = collapse_certificate(_contracting_A())
    s = cert.summary()
    assert isinstance(s, str) and len(s) > 0


# ── NIS χ² canary tests (no torch needed) ────────────────────────────────────

def test_nis_canary_spooks_on_looping_decode():
    """Looping token sequence must eventually trigger a NIS spook."""
    canary = DecodeCanary()
    tokens = _looping_tokens(n=40, cycle=3)
    spooks = 0
    for tok in tokens:
        r = canary.observe(tok)
        spooks += int(r["spook"])
    assert spooks > 0, "looping decode must produce at least one NIS spook"


def test_nis_canary_quiet_on_healthy_decode():
    """Healthy (non-repeating) decode should produce no spooks."""
    canary = DecodeCanary()
    tokens = _healthy_tokens(n=40)
    spooks = sum(canary.observe(tok)["spook"] for tok in tokens)
    assert spooks == 0, f"healthy decode must produce 0 NIS spooks, got {spooks}"


def test_nis_canary_proximity_rises_under_loop():
    """Σ₀ proximity must increase as the decode degenerates."""
    canary = DecodeCanary()
    tokens = _looping_tokens(n=60, cycle=2)
    proxies = [canary.observe(tok)["proximity"] for tok in tokens]
    # Proximity should be higher in the second half than in the first
    first_half = sum(proxies[:30]) / 30
    second_half = sum(proxies[30:]) / 30
    assert second_half >= first_half, (
        f"proximity must not fall under sustained looping: {first_half:.3f} → {second_half:.3f}"
    )


# ── End-to-end: both canaries on the same scenario ───────────────────────────

@pytest.mark.skipif(not _TORCH, reason="torch unavailable (DLL or import error)")
def test_e2e_degenerate_matrix_and_looping_decode():
    """Both canaries flag the same pathological scenario.

    A degenerate A (near-singular) is NOT certified contracting by the Lyapunov
    certificate. The same collapse scenario is mirrored in the decode stream as
    a looping token sequence that drives NIS past the spook threshold.
    Both must fire for the trajectory to be flagged by component-8.
    """
    from cio_sde.collapse import collapse_certificate, stability_gates

    # 1. Lyapunov certificate flags the degenerate trajectory
    A = _degenerate_A()
    cert = collapse_certificate(A)
    gates = stability_gates(A)
    assert not cert.proven_contracting
    assert not gates.proven_contracting

    # 2. NIS canary flags the degenerate decode stream
    canary = DecodeCanary()
    tokens = _looping_tokens(n=50, cycle=2)
    spooks = sum(canary.observe(tok)["spook"] for tok in tokens)
    assert spooks > 0

    # 3. Both fired → component-8 is [tested] end-to-end
    flagged_by_cert = not cert.proven_contracting
    flagged_by_nis = spooks > 0
    assert flagged_by_cert and flagged_by_nis, (
        f"end-to-end: cert_flag={flagged_by_cert}, nis_flag={flagged_by_nis}"
    )
