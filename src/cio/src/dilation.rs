/// dilation.rs — Time dilation field D(v)
///
/// D(v) = f(uncertainty, cost_pressure, confidence)
///
/// High uncertainty   → D > 1  (slow region — explore deeply)
/// High confidence    → D < 1  (fast region — execute quickly)
/// High cost_pressure → D < 1  (compressed — minimize cost/time)
///
/// Range: [D_MIN, D_MAX]

pub const D_MIN: f64 = 0.1;
pub const D_MAX: f64 = 5.0;
pub const D_DEFAULT: f64 = 1.0;

/// Compute scalar dilation for one node.
///
/// # Arguments
/// - `uncertainty`   — 0.0 (certain) → 1.0 (unknown)
/// - `cost_pressure` — 0.0 (none) → 1.0 (must minimize)
/// - `confidence`    — 0.0 (no confidence) → 1.0 (fully confident)
///
/// # Formula
/// ```
/// raw = (1 + uncertainty) / ((1 + confidence) * (1 + cost_pressure))
/// ```
pub fn dilation(uncertainty: f64, cost_pressure: f64, confidence: f64) -> f64 {
    let u = uncertainty.clamp(0.0, 1.0);
    let p = cost_pressure.clamp(0.0, 1.0);
    let c = confidence.clamp(0.0, 1.0);
    let raw = (1.0 + u) / ((1.0 + c) * (1.0 + p));
    raw.clamp(D_MIN, D_MAX)
}

/// Per-node dilation state.
#[derive(Debug, Clone)]
pub struct NodeDilation {
    pub uncertainty:   f64,
    pub cost_pressure: f64,
    pub confidence:    f64,
    pub value:         f64,
}

impl NodeDilation {
    pub fn from_health(health: f64, latency_ratio: f64) -> Self {
        let uncertainty   = (1.0 - health).clamp(0.0, 1.0);
        let cost_pressure = (1.0 - 1.0 / latency_ratio.max(0.01)).max(0.0).min(1.0);
        let confidence    = health * (1.0 - (latency_ratio - 1.0).abs()).max(0.0);
        let value = dilation(uncertainty, cost_pressure, confidence);
        NodeDilation { uncertainty, cost_pressure, confidence, value }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_uncertainty_inflates() {
        assert!(dilation(0.9, 0.0, 0.5) > dilation(0.1, 0.0, 0.5));
    }

    #[test]
    fn high_confidence_deflates() {
        assert!(dilation(0.5, 0.0, 0.9) < dilation(0.5, 0.0, 0.1));
    }

    #[test]
    fn high_cost_pressure_deflates() {
        assert!(dilation(0.5, 0.9, 0.5) < dilation(0.5, 0.1, 0.5));
    }

    #[test]
    fn clamped_min() {
        assert!(dilation(0.0, 1.0, 1.0) >= D_MIN);
    }

    #[test]
    fn clamped_max() {
        assert!(dilation(1.0, 0.0, 0.0) <= D_MAX);
    }

    #[test]
    fn clamps_out_of_range_inputs() {
        let d = dilation(5.0, -1.0, 3.0);
        assert!((D_MIN..=D_MAX).contains(&d));
    }

    #[test]
    fn from_health_healthy() {
        let nd = NodeDilation::from_health(1.0, 1.0);
        assert!(nd.value <= 1.0);
    }

    #[test]
    fn from_health_degraded() {
        let good = NodeDilation::from_health(1.0, 1.0);
        let bad  = NodeDilation::from_health(0.1, 3.0);
        assert!(bad.value > good.value);
    }
}
