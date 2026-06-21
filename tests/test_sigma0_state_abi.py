"""Tests for the Σ₀-K1 state-ABI shim φ/ψ (component 6, #844)."""
import pytest

torch = pytest.importorskip("torch")

from sigma0.state_abi import StateABI, D_MIN, D_MAX


def test_shapes_batched_and_single():
    abi = StateABI(hidden_dim=512, state_dim=128)
    h = torch.randn(7, 512)
    x = abi.phi(h)
    assert x.shape == (7, 128)
    assert abi.psi(x).shape == (7, 512)
    # single vector (no batch dim)
    assert abi.phi(torch.randn(512)).shape == (128,)


def test_phi_psi_is_left_inverse_exactly():
    # For any orthonormal-column U, φ(ψ(x)) == x exactly (UᵀU = I_d).
    abi = StateABI(hidden_dim=256, state_dim=64, seed=3)
    x = torch.randn(5, 64)
    assert torch.allclose(abi.phi(abi.psi(x)), x, atol=1e-4)


def test_psi_phi_is_idempotent_projection():
    # ψ∘φ projects onto span(U): applying it twice == once.
    abi = StateABI(hidden_dim=256, state_dim=64, seed=1)
    h = torch.randn(4, 256)
    once = abi.psi(abi.phi(h))
    twice = abi.psi(abi.phi(once))
    assert torch.allclose(once, twice, atol=1e-4)


def test_seed_determinism():
    a = StateABI(128, 64, seed=42)
    b = StateABI(128, 64, seed=42)
    c = StateABI(128, 64, seed=43)
    assert torch.allclose(a.U, b.U)
    assert not torch.allclose(a.U, c.U)


def test_fit_recovers_low_rank_subspace():
    # Synthetic data that genuinely lives in an affine d-subspace: PCA must round-trip it.
    torch.manual_seed(0)
    H, d, N = 200, 96, 2000
    W, _ = torch.linalg.qr(torch.randn(H, d))   # orthonormal H×d basis of the true subspace
    mu0 = torch.randn(H)
    z = torch.randn(N, d)
    data = z @ W.T + mu0                          # rank-d affine data

    fitted = StateABI(H, d, seed=0).fit(data)
    err_fit = fitted.roundtrip_error(data)
    err_random = StateABI(H, d, seed=0).roundtrip_error(data)

    assert err_fit < 1e-3, f"PCA round-trip should recover the subspace, got {err_fit}"
    assert err_fit < err_random / 10, f"fit ({err_fit}) must beat random ({err_random})"
    assert fitted.fitted is True


def test_state_dim_bounds():
    with pytest.raises(ValueError):
        StateABI(512, D_MIN - 1)        # below 64
    with pytest.raises(ValueError):
        StateABI(512, D_MAX + 1)        # above 256
    with pytest.raises(ValueError):
        StateABI(100, 128)              # state_dim > hidden_dim


def test_x_from_exit_hiddens_reductions():
    abi = StateABI(128, 64)
    exit_hiddens = [torch.randn(128) for _ in range(5)]   # loop_lm-style list of (H,)
    assert abi.x_from_exit_hiddens(exit_hiddens, reduce="mean").shape == (64,)
    assert abi.x_from_exit_hiddens(exit_hiddens, reduce="last").shape == (64,)
    assert abi.x_from_exit_hiddens(exit_hiddens, reduce="none").shape == (5, 64)


def test_save_load_roundtrip(tmp_path):
    abi = StateABI(128, 64, seed=7)
    abi.fit(torch.randn(300, 128))
    p = str(tmp_path / "abi.pt")
    abi.save(p)
    back = StateABI.load(p)
    assert back.fitted and back.state_dim == 64 and back.hidden_dim == 128
    h = torch.randn(3, 128)
    assert torch.allclose(abi.phi(h), back.phi(h), atol=1e-5)
