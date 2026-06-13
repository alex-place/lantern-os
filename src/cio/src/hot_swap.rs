/// hot_swap.rs — Hot-swap engine σ: v_old → v_new
///
/// Replaces degraded nodes at runtime while preserving semantic continuity.
/// Uses SwapHysteresis to prevent oscillatory provider switching.
///
/// Invariant: at least one eligible ResourceNode must remain after any swap.

use crate::graph::{CEGGraph, NodeId, NodeKind, NodeData};

/// Minimum improvement score required for a swap (ε).
pub const DEFAULT_EPSILON: f64 = 0.05;
/// Default cooldown between swaps of the same node (seconds).
pub const DEFAULT_COOLDOWN_S: f64 = 30.0;
/// Default stability threshold below which swaps are blocked.
pub const DEFAULT_STABILITY_THRESHOLD: f64 = 0.6;
/// EMA weight for stability updates.
pub const DEFAULT_STABILITY_ALPHA: f64 = 0.2;

// ── SwapHysteresis ────────────────────────────────────────────────────────────

/// Stability condition — prevents oscillatory provider switching.
///
/// swap_allowed(v) only if:
///     improvement_score > ε
///     AND cooldown_elapsed
///     AND stability(v) > threshold
pub struct SwapHysteresis {
    pub epsilon:             f64,
    pub cooldown_s:          f64,
    pub stability_threshold: f64,
    pub stability_alpha:     f64,

    // Tracks last swap wall-clock instant (seconds since Unix epoch stub)
    last_swap_tick: std::collections::HashMap<NodeId, u64>,
    stability:      std::collections::HashMap<NodeId, f64>,
    current_tick:   u64,
}

impl SwapHysteresis {
    pub fn new(epsilon: f64, cooldown_ticks: u64, stability_threshold: f64, alpha: f64) -> Self {
        SwapHysteresis {
            epsilon,
            cooldown_s: cooldown_ticks as f64,
            stability_threshold,
            stability_alpha: alpha,
            last_swap_tick: Default::default(),
            stability: Default::default(),
            current_tick: 0,
        }
    }

    pub fn advance_tick(&mut self) { self.current_tick += 1; }

    /// Update stability EMA for a node. Returns new stability score.
    pub fn observe_health(&mut self, node_id: NodeId, health: f64) -> f64 {
        let current = self.stability.get(&node_id).copied().unwrap_or(health);
        let updated = (1.0 - self.stability_alpha) * current + self.stability_alpha * health;
        self.stability.insert(node_id, updated);
        updated
    }

    pub fn stability(&self, node_id: NodeId) -> f64 {
        self.stability.get(&node_id).copied().unwrap_or(0.5)
    }

    /// Returns (allowed, reason).
    pub fn swap_allowed(
        &self,
        old_id: NodeId,
        improvement_score: f64,
    ) -> (bool, &'static str) {
        if improvement_score <= self.epsilon {
            return (false, "improvement below epsilon");
        }
        let last = self.last_swap_tick.get(&old_id).copied().unwrap_or(0);
        if self.current_tick.saturating_sub(last) < self.cooldown_s as u64 {
            return (false, "cooldown not elapsed");
        }
        if self.stability(old_id) < self.stability_threshold {
            return (false, "node stability below threshold");
        }
        (true, "ok")
    }

    pub fn record_swap(&mut self, old_id: NodeId) {
        self.last_swap_tick.insert(old_id, self.current_tick);
    }
}

impl Default for SwapHysteresis {
    fn default() -> Self {
        SwapHysteresis::new(
            DEFAULT_EPSILON,
            30,
            DEFAULT_STABILITY_THRESHOLD,
            DEFAULT_STABILITY_ALPHA,
        )
    }
}

// ── SwapTrigger ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum SwapTrigger {
    CapabilityDegraded,
    LatencyViolation,
    CostSpike,
    AuthorityRevoked,
    Manual,
}

// ── SwapEvent ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SwapEvent {
    pub old_id:    NodeId,
    pub new_id:    NodeId,
    pub trigger:   SwapTrigger,
    pub success:   bool,
    pub reason:    String,
}

// ── HotSwapEngine ─────────────────────────────────────────────────────────────

/// Executes σ operators on the CEGGraph when trigger conditions fire.
pub struct HotSwapEngine {
    /// node_id → ordered list of candidate replacement NodeIds
    candidates:     std::collections::HashMap<NodeId, Vec<NodeId>>,
    hysteresis:     SwapHysteresis,
    history:        Vec<SwapEvent>,
    health_threshold: f64,
    latency_tolerance: f64,
}

impl HotSwapEngine {
    pub fn new(hysteresis: SwapHysteresis) -> Self {
        HotSwapEngine {
            candidates: Default::default(),
            hysteresis,
            history: vec![],
            health_threshold: 0.4,
            latency_tolerance: 2.0,
        }
    }

    pub fn register_candidate(&mut self, node_id: NodeId, candidate_id: NodeId) {
        self.candidates.entry(node_id).or_default().push(candidate_id);
    }

    fn check_trigger(
        &self,
        provider_id: &str,
        latency_target_ms: f64,
        dilation: f64,
        health: &std::collections::HashMap<String, f64>,
        latency: &std::collections::HashMap<String, f64>,
        max_cost: f64,
        cost_per_token: f64,
    ) -> Option<SwapTrigger> {
        let h = health.get(provider_id).copied().unwrap_or(1.0);
        if h < self.health_threshold {
            return Some(SwapTrigger::CapabilityDegraded);
        }
        let lat = latency.get(provider_id).copied().unwrap_or(latency_target_ms);
        if lat > latency_target_ms * dilation * self.latency_tolerance {
            return Some(SwapTrigger::LatencyViolation);
        }
        if cost_per_token * 1000.0 > max_cost * 1.5 {
            return Some(SwapTrigger::CostSpike);
        }
        None
    }

    /// Check all ResourceNodes for triggers; execute swaps if hysteresis allows.
    /// Returns list of SwapEvents.
    pub fn check_and_swap(
        &mut self,
        graph: &mut CEGGraph,
        health: &std::collections::HashMap<String, f64>,
        latency: &std::collections::HashMap<String, f64>,
        max_cost: f64,
        tick: u64,
    ) -> Vec<SwapEvent> {
        self.hysteresis.current_tick = tick;

        // Collect candidate swaps before mutating graph
        let swap_targets: Vec<(NodeId, SwapTrigger, f64)> = {
            let resource_ids: Vec<_> = graph.nodes_by_kind(&NodeKind::Resource)
                .iter()
                .map(|n| n.id)
                .collect();

            resource_ids.into_iter().filter_map(|id| {
                let node = graph.get_node(id)?;
                let trigger = if let NodeData::Resource {
                    provider_id, latency_target_ms, cost_per_token, ..
                } = &node.data {
                    self.check_trigger(
                        provider_id, *latency_target_ms, node.dilation,
                        health, latency, max_cost, *cost_per_token,
                    )
                } else { None };

                let h_old = if let NodeData::Resource { provider_id, .. } = &node.data {
                    health.get(provider_id.as_str()).copied().unwrap_or(1.0)
                } else { 1.0 };

                trigger.map(|t| (id, t, h_old))
            }).collect()
        };

        let mut events = vec![];
        for (old_id, trigger, h_old) in swap_targets {
            let candidates = match self.candidates.get(&old_id) {
                Some(c) if !c.is_empty() => c.clone(),
                _ => continue,
            };

            // Pick best candidate
            let new_id = candidates[0]; // v1.0: first registered wins
            let new_node = match graph.get_node(new_id) {
                Some(n) => n,
                None => continue,
            };
            let h_new = if let NodeData::Resource { provider_id, .. } = &new_node.data {
                health.get(provider_id.as_str()).copied().unwrap_or(1.0)
            } else { 1.0 };

            let improvement = (h_new - h_old) / h_old.max(0.01);
            let (allowed, reason) = self.hysteresis.swap_allowed(old_id, improvement);

            if !allowed {
                events.push(SwapEvent {
                    old_id, new_id, trigger,
                    success: false,
                    reason: reason.to_string(),
                });
                continue;
            }

            let removed = graph.swap_nodes(old_id, new_id);
            let success = removed.is_some();
            if success {
                self.hysteresis.record_swap(old_id);
            }
            events.push(SwapEvent {
                old_id, new_id, trigger,
                success,
                reason: if success { "ok".into() } else { "swap_nodes returned None".into() },
            });
        }

        self.history.extend(events.iter().cloned());
        events
    }

    pub fn swap_history(&self) -> &[SwapEvent] { &self.history }

    pub fn advance_tick(&mut self) { self.hysteresis.advance_tick(); }
}

impl Default for HotSwapEngine {
    fn default() -> Self { HotSwapEngine::new(SwapHysteresis::default()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hysteresis_allows_good_improvement() {
        let h = SwapHysteresis::new(0.05, 0, 0.0, 0.2);
        let (ok, _) = h.swap_allowed(NodeId::new(0), 0.5);
        assert!(ok);
    }

    #[test]
    fn hysteresis_blocks_small_improvement() {
        let h = SwapHysteresis::new(0.2, 0, 0.0, 0.2);
        let (ok, reason) = h.swap_allowed(NodeId::new(0), 0.1);
        assert!(!ok);
        assert!(reason.contains("epsilon"));
    }

    #[test]
    fn hysteresis_blocks_during_cooldown() {
        let mut h = SwapHysteresis::new(0.01, 10, 0.0, 0.2);
        h.record_swap(NodeId::new(0));
        h.current_tick = 5;
        let (ok, reason) = h.swap_allowed(NodeId::new(0), 0.9);
        assert!(!ok);
        assert!(reason.contains("cooldown"));
    }

    #[test]
    fn hysteresis_stability_ema() {
        let mut h = SwapHysteresis::new(0.0, 0, 0.0, 1.0); // alpha=1.0 → instant
        h.observe_health(NodeId::new(0), 0.3);
        assert!((h.stability(NodeId::new(0)) - 0.3).abs() < 1e-9);
    }
}
