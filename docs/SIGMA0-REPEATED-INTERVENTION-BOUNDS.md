# Sigma0: repeated intervention bounds and proof obligations

## 1. Covariance boundedness is not implied by one-step excitation

For a discrete linearized covariance model

\[ P_{t+1}=F_tP_tF_t^T+N_t,\qquad P_t\succeq0,\quad N_t\succeq0, \]

a nonzero intervention covariance does not by itself imply bounded covariance. In the scalar case P[t+1]=a²P[t]+q, covariance is bounded only for |a|<1. It grows linearly for |a|=1 and exponentially for |a|>1, when q>0.

A sufficient switched-system condition is a common quadratic metric H≻0, a contraction factor 0≤ρ<1, and a uniform noise budget q≥0, such that every admissible transition satisfies

\[ F_t^THF_t\preceq\rho^2H,\qquad \operatorname{tr}(HN_t)\leq q. \]

Then

\[ \operatorname{tr}(HP_t)\leq\rho^{2t}\operatorname{tr}(HP_0)+q\frac{1-\rho^{2t}}{1-\rho^2}. \]

This is sufficient, not necessary. It is a deployed-system guarantee only if the inequalities hold for every reachable mode and operating state. A finite sample of Jacobians does not establish that coverage.

## 2. Why per-mode eigenvalues are insufficient

Let F1=[[0,2],[0,0]] and F2=[[0,0],[2,0]]. Each is nilpotent with spectral radius zero, but F2 F1=diag(0,4) has spectral radius four. Alternating individually stable modes can therefore produce an expanding switched product. A common Lyapunov certificate, or a multiple-Lyapunov / dwell-time argument, is needed.

## 3. Excitation must survive the horizon

For x[k+1]=F[k]x[k]+M[k]ξ[k], with temporally independent standard innovations, the terminal excitation Gramian is

\[ W_{0,T}=\sum_{k=0}^{T-1}\Phi(T,k+1)M_kM_k^T\Phi(T,k+1)^T, \]

where Φ(T,k+1)=F[T−1]⋯F[k+1]. A positive-definite Gramian means every state direction receives nonzero excitation that remains visible at the horizon. A one-step kick alone does not guarantee this: later dynamics can erase it.

For correlated or shared innovations, retain the joint noise covariance and cross terms; the independent-innovation formula is not valid without that assumption.

## 4. Executable finite-dimensional verifiers

The runtime package exposes `src.cio_sde.stability`:

- `verify_common_quadratic(modes, H, rho)` checks positive definiteness of H and every supplied matrix inequality. A pass covers only those exact matrices. The caller must establish that the mode list covers every reachable closed-loop Jacobian.
- `finite_horizon_excitation_gramian(Fs, Ms)` computes the terminal Gramian for the supplied finite sequence. It assumes temporally independent standard innovations unless the maps already encode their joint covariance.
- `covariance_energy_bound(P0, H, rho, q, n)` evaluates the analytical common-quadratic upper bound.
- `augmented_transition_jacobian(T, z)` differentiates a caller-supplied complete continuous augmented transition. Include every continuous feedback state, such as x, vec(P), vec(S), and controller memory. Discrete graph modes still require separate enumeration/certification.

These are verification primitives and finite examples, not a search algorithm for arbitrary Lyapunov metrics and not an end-to-end proof for the deployed nonlinear controller. A candidate metric found by numerical optimization must still pass the verifier with a positive margin and a justified enclosure of all reachable modes.

## 5. Augmented-state obligation

If the controller depends on covariance or shape state, the relevant closed-loop map is the full continuous augmented transition, e.g. z=(x,vec(P),vec(S),m), z_next=T(z,ξ,ω), where m includes continuous controller memory. Its Jacobian includes covariance-to-state and shape-to-state feedback. Discrete graph changes must be treated as separate modes. This local Jacobian is not a global stability proof unless its bounds hold throughout an invariant operating region.