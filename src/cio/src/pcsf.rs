/// PCSF — Priority Constraint Satisfaction Framework
///
/// P* = argmin Cost(P) subject to Constraints
///
/// Cost(P) = w1*latency + w2*compute_cost + w3*risk + w4*instability
///
/// Continuous re-optimization:
///     P(t+Δt) = reoptimize(P(t), G, S, D)

use crate::graph::{CEGGraph, NodeKind, NodeData, NodeId, Severity};
use crate::csf::Constraints;

/// Weights for the cost function.
#[derive(Debug, Clone)]
pub struct CostWeights {
    pub latency:     f64,
    pub compute:     f64,
    pub risk:        f64,
    pub instability: f64,
}

impl Default for CostWeights {
    fn default() -> Self {
        CostWeights {
            latency:     0.3,
            compute:     0.4,
            risk:        0.2,
            instability: 0.1,
        }
    }
}

/// A single planned execution step — one selected ResourceNode.
#[derive(Debug, Clone)]
pub struct ExecutionStep {
    pub node_id:            NodeId,
    pub estimated_cost:     f64,
    pub estimated_latency_ms: f64,
    pub dilated_latency_ms: f64,
}

/// The optimizer output — an ordered list of steps satisfying the contract.
#[derive(Debug, Clone)]
pub struct ExecutionPlan {
    pub steps:                Vec<ExecutionStep>,
    pub total_cost:           f64,
    pub total_latency_ms:     f64,
    pub feasible:             bool,
    pub infeasibility_reason: String,
}

impl ExecutionPlan {
    pub fn infeasible(reason: impl Into<String>) -> Self {
        ExecutionPlan {
            steps: vec![],
            total_cost: 0.0,
            total_latency_ms: 0.0,
            feasible: false,
            infeasibility_reason: reason.into(),
        }
    }
}

/// Resource snapshot passed to the optimizer each tick.
#[derive(Debug, Clone, Default)]
pub struct ResourceSnapshot {
    /// provider_id → health [0.0, 1.0]
    pub health:  std::collections::HashMap<String, f64>,
    /// provider_id → observed latency (ms)
    pub latency: std::collections::HashMap<String, f64>,
}

/// PCSF optimizer — selects the minimum-cost feasible resource.
pub struct PCSFOptimizer {
    pub weights: CostWeights,
}

impl Default for PCSFOptimizer {
    fn default() -> Self { PCSFOptimizer { weights: CostWeights::default() } }
}

impl PCSFOptimizer {
    pub fn new(weights: CostWeights) -> Self { PCSFOptimizer { weights } }

    fn node_cost(
        &self,
        provider_id: &str,
        cost_per_token: f64,
        latency_target_ms: f64,
        dilation: f64,
        snapshot: &ResourceSnapshot,
    ) -> f64 {
        let health   = snapshot.health.get(provider_id).copied().unwrap_or(1.0);
        let lat      = snapshot.latency.get(provider_id).copied().unwrap_or(latency_target_ms);
        let dilated  = lat * dilation;

        let lat_cost  = dilated / 10_000.0;
        let comp_cost = cost_per_token * 1000.0;
        let risk      = 1.0 - health;
        let instab    = 0.0; // instability tracking added in v1.1

        let w = &self.weights;
        w.latency * lat_cost + w.compute * comp_cost + w.risk * risk + w.instability * instab
    }

    /// Optimize: find the lowest-cost ResourceNode satisfying constraints.
    pub fn optimize(
        &self,
        graph: &CEGGraph,
        constraints: &Constraints,
        snapshot: &ResourceSnapshot,
        allowed_resources: &[String],
        forbidden_resources: &[String],
    ) -> ExecutionPlan {
        // Check hard constraints first
        for node in graph.nodes_by_kind(&NodeKind::Constraint) {
            if let NodeData::Constraint { severity: Severity::Hard, satisfied: Some(false), predicate, .. } = &node.data {
                return ExecutionPlan::infeasible(
                    format!("hard constraint violated: {predicate}")
                );
            }
        }

        // Collect candidate resource nodes
        let candidates: Vec<_> = graph.nodes_by_kind(&NodeKind::Resource)
            .into_iter()
            .filter(|n| {
                if let NodeData::Resource { provider_id, .. } = &n.data {
                    if forbidden_resources.contains(provider_id) { return false; }
                    if !allowed_resources.is_empty() && !allowed_resources.contains(provider_id) { return false; }
                    true
                } else { false }
            })
            .collect();

        if candidates.is_empty() {
            return ExecutionPlan::infeasible("no eligible ResourceNodes");
        }

        // Score candidates
        let mut scored: Vec<(f64, &crate::graph::Node)> = candidates.iter().map(|n| {
            let cost = if let NodeData::Resource { provider_id, cost_per_token, latency_target_ms, .. } = &n.data {
                self.node_cost(provider_id, *cost_per_token, *latency_target_ms, n.dilation, snapshot)
            } else { f64::MAX };
            (cost, *n)
        }).collect();
        scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        // Pick first candidate within budget
        for (_, node) in scored {
            if let NodeData::Resource { provider_id, cost_per_token, latency_target_ms, .. } = &node.data {
                let lat = snapshot.latency.get(provider_id.as_str()).copied().unwrap_or(*latency_target_ms);
                let dilated = lat * node.dilation;
                let cost = cost_per_token * 1000.0;

                if cost > constraints.max_cost { continue; }
                if dilated > constraints.max_latency_ms { continue; }

                return ExecutionPlan {
                    steps: vec![ExecutionStep {
                        node_id: node.id,
                        estimated_cost: cost,
                        estimated_latency_ms: lat,
                        dilated_latency_ms: dilated,
                    }],
                    total_cost: cost,
                    total_latency_ms: dilated,
                    feasible: true,
                    infeasibility_reason: String::new(),
                };
            }
        }

        ExecutionPlan::infeasible("no candidate satisfies cost+latency constraints")
    }

    /// Continuous re-optimization — called each tick.
    pub fn reoptimize(
        &self,
        _current: &ExecutionPlan,
        graph: &CEGGraph,
        constraints: &Constraints,
        snapshot: &ResourceSnapshot,
        allowed: &[String],
        forbidden: &[String],
    ) -> ExecutionPlan {
        self.optimize(graph, constraints, snapshot, allowed, forbidden)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{CEGGraph, NodeKind, NodeData, ResourceKind};

    fn make_graph(providers: &[&str]) -> CEGGraph {
        let mut g = CEGGraph::new();
        for p in providers {
            g.add_node(NodeKind::Resource, *p, NodeData::Resource {
                resource_kind: ResourceKind::LLM,
                provider_id: p.to_string(),
                capabilities: vec!["chat".into()],
                cost_per_token: 0.001,
                latency_target_ms: 500.0,
                health: 1.0,
            });
        }
        g
    }

    fn default_snapshot(providers: &[&str]) -> ResourceSnapshot {
        let mut s = ResourceSnapshot::default();
        for p in providers {
            s.health.insert(p.to_string(), 1.0);
            s.latency.insert(p.to_string(), 400.0);
        }
        s
    }

    #[test]
    fn optimizer_selects_feasible_resource() {
        let g = make_graph(&["anthropic", "openai"]);
        let c = Constraints::default();
        let snap = default_snapshot(&["anthropic", "openai"]);
        let plan = PCSFOptimizer::default().optimize(&g, &c, &snap, &[], &[]);
        assert!(plan.feasible);
        assert_eq!(plan.steps.len(), 1);
    }

    #[test]
    fn optimizer_respects_forbidden() {
        let g = make_graph(&["anthropic"]);
        let c = Constraints::default();
        let snap = default_snapshot(&["anthropic"]);
        let plan = PCSFOptimizer::default().optimize(&g, &c, &snap, &[], &["anthropic".to_string()]);
        assert!(!plan.feasible);
    }

    #[test]
    fn optimizer_respects_allowed_list() {
        let g = make_graph(&["anthropic", "openai"]);
        let c = Constraints::default();
        let snap = default_snapshot(&["anthropic", "openai"]);
        let plan = PCSFOptimizer::default().optimize(&g, &c, &snap, &["openai".to_string()], &[]);
        assert!(plan.feasible);
        // The selected node must be openai
        let node = g.get_node(plan.steps[0].node_id).unwrap();
        if let NodeData::Resource { provider_id, .. } = &node.data {
            assert_eq!(provider_id, "openai");
        } else { panic!("not a resource"); }
    }

    #[test]
    fn optimizer_infeasible_no_resources() {
        let g = CEGGraph::new();
        let c = Constraints::default();
        let plan = PCSFOptimizer::default().optimize(&g, &c, &ResourceSnapshot::default(), &[], &[]);
        assert!(!plan.feasible);
    }

    #[test]
    fn optimizer_hard_constraint_blocks() {
        use crate::graph::Severity;
        let mut g = make_graph(&["anthropic"]);
        g.add_node(NodeKind::Constraint, "no_pii", NodeData::Constraint {
            predicate: "no_pii".into(),
            scope: "global".into(),
            severity: Severity::Hard,
            satisfied: Some(false),
        });
        let c = Constraints::default();
        let snap = default_snapshot(&["anthropic"]);
        let plan = PCSFOptimizer::default().optimize(&g, &c, &snap, &[], &[]);
        assert!(!plan.feasible);
        assert!(plan.infeasibility_reason.contains("hard constraint"));
    }
}
