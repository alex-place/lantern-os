# Sigma0 repeated-intervention limits and sufficient conditions

Status: engineering contract and sufficient conditions, not a proof that the deployed
nonlinear closed loop satisfies them.

## 1. Split covariance semantics

For split-mode state (x_t), belief covariance (P_t), shape metric (S_t), and
closed-loop drift (b(x,P)=f(x,\pi(x,P))), define the local closed-loop Jacobian

[
J_t = \frac{\partial b}{\partial x}(x_t,P_t), \qquad F_t=I+\Delta t J_t.
]

With executed shared-noise map (M_t\xi_t), the prediction is

[
P_{t+1}^{-}=F_tP_tF_t^T+M_tM_t^T.
]

An observation (y_t=H_tx_t+v_t), (v_t\sim(0,R_t)), is assimilated only when
the caller supplies it. The Joseph update is

[
K_t=P^-H_t^T(H_tP^-H_t^T+R_t)^{-1},
]
[
P_t=(I-K_tH_t)P^-(I-K_tH_t)^T+K_tR_tK_t^T.
]

This is a linearized, discrete-time filter approximation. It is not a calibrated
posterior for nonlinear dynamics unless the observation and noise assumptions hold.
The old single-Sigma API retains the historical continuous Riccati surrogate for
compatibility.

The shape metric has a different purpose:

[
S_{t+1}=\Pi_{shape}(F_tS_tF_t^T+L_t),
]

where (L_t\succeq0) is the deliberate C3 shape lift and \(\Pi_{shape}\) is
the bounded shape-preserving projection. Neither (M_tM_t^T) nor a measurement
update is added to S. Conversely, L is not written into P.

The Jacobian used in split mode differentiates the composed drift
(f(x,\pi(x,P))) with P held fixed. This includes policy feedback but not the
dependence of P on x. The latter is a joint augmented-state effect and must be
included if a theorem or application requires the full closed-loop state
((x,P,S)).

## 2. Batch independence contract

Per-sample gradients obtained by differentiating a sum of batch costs are valid
as independent member gradients only when cross-member Jacobian blocks vanish.
The runtime now checks off-diagonal batch blocks for:

- stage cost with respect to state;
- policy with respect to state;
- drift with respect to state and control;
- diffusion with respect to state.

If the check fails or cannot be evaluated, per-sample anti-collapse refuses to
run. This is a guard, not a proof against every possible stateful side channel:
custom modules with hidden cross-call state, stochastic batch-dependent behavior,
or unmodeled external coupling still require separate validation. A genuinely
coupled batch must be modeled as one joint state and analyzed with its full
Jacobian, not split into fictitiously independent samples.

## 3. What would prove repeated boundedness?

Write the covariance recursion as

[
P_{t+1}=F_tP_tF_t^T+N_t,qquad N_t\succeq0.
]

A sufficient common-quadratic condition is: there exist (H\succ0),
(0\le\rho<1), and (q<\infty), such that for every admissible closed-loop
mode and every reachable state,

[
F_t^THF_t\preceq\rho^2H,qquad
\operatorname{tr}(HN_t)\le q.
]

Then

[
\operatorname{tr}(HP_t)\le
\rho^{2t}\operatorname{tr}(HP_0)+
q\frac{1-\rho^{2t}}{1-\rho^2}.
]

This is a sufficient bound, not a necessary one. It must hold for the actual
closed-loop Jacobians, including controller feedback, and for every allowed
graph swap/intervention mode. A numerical eigenvalue check at each step is not
enough.

For arbitrary switching, a common H may not exist. Alternatives include a
multiple-Lyapunov function with a verified dwell-time condition, a joint
spectral-radius bound, or a contraction argument in a state-dependent metric.
The proof must cover the allowed switching signal, not merely each matrix in
isolation.

### Counterexample: individually stable modes, unstable switching

Let

[
F_1=\begin{bmatrix}0&2\\0&0\end{bmatrix},\qquad
F_2=\begin{bmatrix}0&0\\2&0\end{bmatrix}.
]

Both are nilpotent and have spectral radius zero. But

[
F_2F_1=\begin{bmatrix}0&0\\0&4\end{bmatrix},
]

so alternating modes amplifies one direction by four every two steps.
Per-mode spectral radius, even zero, does not establish switched stability.

The covariance cap in code is a numerical bound, not a stability theorem:
repeated clipping can hide an unbounded pre-projection covariance.

## 4. What would prove retained excitation?

A one-step kick only proves that energy was injected at that step. Let
(Phi(t+k+1,t+1)=F_{t+k}\cdots F_{t+1}). The finite-horizon excitation
Gramian is

[
W_{t,T}=\sum_{k=0}^{T-1}
\Phi(t+k+1,t+1)M_{t+k}M_{t+k}^T
\Phi(t+k+1,t+1)^T.
]

A persistent-excitation claim needs a uniform lower bound
(W_{t,T}\succeq\alpha I) for all relevant t, with fixed finite T and
(alpha>0), or a clearly specified restricted subspace version. The present
operator does not establish this condition.

### Counterexample: a later mode erases a kick

A kick in the first coordinate followed by
(F_2=\operatorname{diag}(0,0,0,1)) is erased if it lies in the first
three coordinates. Even non-expansive transitions can remove all of the
previously excited subspace. A retention theorem therefore needs a lower bound
on the switched transition product restricted to the kicked subspace, or an
excitation schedule that re-injects energy with a verified Gramian condition.

## 5. Bounded excitation is not retained excitation

If kicks are bounded, (|M_t|\le m), and a common contraction condition
holds, then the covariance energy has a finite upper bound as in Section 3.
But a positive lower bound on excitation is a separate property. Conversely,
with neutral dynamics (F_t=I) and repeated nonzero (N_t), covariance grows
linearly before any numerical cap is applied. A hard cap prevents numerical
overflow by discarding information; it does not prove the underlying process
is bounded.

## 6. Remaining theorem obligations

Before claiming an end-to-end anti-collapse guarantee, establish all of:

1. The true closed-loop augmented Jacobian, including policy and any dependence
   of the controller on P/S that matters to the state transition.
2. A switching stability certificate covering every graph mode and intervention.
3. A uniform bound on intervention energy and on the actual shared-noise map.
4. A finite-horizon excitation Gramian lower bound on the intended subspace.
5. Observation-model validity and calibrated innovation statistics if P is
   interpreted probabilistically.
6. Independence or a full joint-batch analysis.
7. Numerical error bounds for SVD rank decisions, PSD projections, and finite
   precision at the dimensions and condition numbers used in deployment.

Until these are established, the honest claim is narrower: the implementation
has one-step C3 shape-lift logic, a per-sample gate with explicit independence
checks, and an opt-in covariance split. It does not yet prove perpetual
excitation, switched stability, or universal non-collapse.


## 7. Executable finite-dimensional verifiers

The runtime package now exposes `src.cio_sde.stability`:

- `verify_common_quadratic(modes, H, rho)` checks positive definiteness of H
  and every supplied matrix inequality. A pass is a valid certificate for
  those matrices only. It does not prove that the list contains all reachable
  nonlinear closed-loop Jacobians.
- `finite_horizon_excitation_gramian(Fs, Ms)` computes the terminal Gramian
  for the supplied finite sequence. It assumes the per-step noise vectors are
  temporally independent (or that the maps have already been augmented to
  represent their true joint covariance).
- `covariance_energy_bound(P0, H, rho, q, n)` evaluates the analytical
  common-quadratic upper bound.
- `augmented_transition_jacobian(T, z)` differentiates a caller-supplied
  complete continuous augmented transition. The caller must include every
  continuous feedback state, such as x, vec(P), vec(S), and controller memory.
  Discrete graph modes still require separate enumeration/certification.

Tests include a contracting switched family, the alternating nilpotent
counterexample, cyclic coordinate kicks with a positive terminal Gramian, an
erased-kick example with zero terminal Gramian, and a toy augmented transition
whose Jacobian contains covariance-to-state feedback.

These are executable verification primitives and finite examples, not a
search algorithm for arbitrary Lyapunov metrics and not an end-to-end proof
for the deployed CIO_SDE controller. A candidate metric found by numerical
optimization would still need to pass the verifier with a positive numerical
margin and a justified enclosure of all reachable modes.
