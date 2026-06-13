/// executor.rs — CIO execution loop
///
/// Formal execution loop (v0.4 spec):
///
/// while not complete:
///     observe S(t)
///     update D
///     evaluate constraints (NAP + EC)
///     PCSF.reoptimize()
///     if swap_required: execute_swap()
///     execute_step()
///     emit_trace()
///     update M
///
/// S(t+1) = delta(S(t), event)

use crate::csf::{CSF, NodeKindSpec};
use crate::graph::{CEGGraph, NodeKind, NodeData, ResourceKind, NodeId, FeatureState};
use crate::pcsf::{PCSFOptimizer, ExecutionPlan, ResourceSnapshot};
use crate::dilation::NodeDilation;
use crate::hot_swap::HotSwapEngine;

// ── TraceEvent ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TraceEvent {
    pub tick:          u64,
    pub event:         String,
    pub node_id:       Option<NodeId>,
    pub plan_feasible: bool,
    pub swap_count:    usize,
    pub violations:    Vec<String>,
}

// ── CIOState ──────────────────────────────────────────────────────────────────

/// S(t) — mutable runtime state threaded through the execution loop.
/// S(t+1) = delta(S(t), event)
#[derive(Debug, Default, Clone)]
pub struct CIOState {
    /// R — resource health + latency snapshots.
    pub resources: ResourceSnapshot,
    /// M — memory entries (node_id string -> summary).
    pub memory:    std::collections::HashMap<String, String>,
    /// P — active NAP predicates (denied list).
    pub active_constraints: Vec<String>,
    /// Execution trace (one entry per tick).
    pub trace:     Vec<TraceEvent>,
    /// Current tick number.
    pub tick:      u64,
    /// Whether the last tick achieved a feasible plan with no violations.
    pub complete:  bool,
}

impl CIOState {
    /// Apply a trace event to advance state.
    pub fn advance(&mut self, event: TraceEvent) {
        self.tick = event.tick;
        self.complete = event.plan_feasible && event.violations.is_empty();
        self.trace.push(event);
    }
}

// ── CIOExecutor ───────────────────────────────────────────────────────────────

pub struct CIOExecutor {
    pub graph:     CEGGraph,
    pub optimizer: PCSFOptimizer,
    pub hot_swap:  Option<HotSwapEngine>,
    pub max_ticks: u64,
}

impl CIOExecutor {
    pub fn new(graph: CEGGraph, optimizer: PCSFOptimizer, max_ticks: u64) -> Self {
        CIOExecutor { graph, optimizer, hot_swap: None, max_ticks }
    }

    pub fn with_hot_swap(mut self, engine: HotSwapEngine) -> Self {
        self.hot_swap = Some(engine);
        self
    }

    /// Build a CIOExecutor from a CSF spec (graph_spec is used to seed nodes).
    pub fn from_csf(csf: &CSF) -> Self {
        use crate::graph::EdgeKind;
        use crate::csf::EdgeKindSpec;

        let mut graph = CEGGraph::new();
        let mut id_map: std::collections::HashMap<String, NodeId> = Default::default();

        for ns in &csf.graph_spec.nodes {
            let kind = match ns.kind {
                NodeKindSpec::Resource   => NodeKind::Resource,
                NodeKindSpec::Constraint => NodeKind::Constraint,
                NodeKindSpec::Authority  => NodeKind::Authority,
                NodeKindSpec::Memory     => NodeKind::Memory,
                NodeKindSpec::Trace      => NodeKind::Trace,
                NodeKindSpec::Projection => NodeKind::Projection,
                NodeKindSpec::Intent     => NodeKind::Intent,
            };
            let data = match ns.kind {
                NodeKindSpec::Resource => NodeData::Resource {
                    resource_kind:     ResourceKind::LLM,
                    provider_id:       ns.provider_id.clone().unwrap_or_default(),
                    capabilities:      vec!["chat".into()],
                    cost_per_token:    ns.cost.unwrap_or(0.001),
                    latency_target_ms: ns.latency_ms.unwrap_or(500.0),
                    health:            ns.health.unwrap_or(1.0),
                },
                _ => NodeData::Intent { raw_text: ns.label.clone(), embedding: vec![] },
            };
            let gid = graph.add_node(kind, &ns.label, data);
            id_map.insert(ns.id.clone(), gid);
        }

        for es in &csf.graph_spec.edges {
            if let (Some(&src), Some(&dst)) = (id_map.get(&es.src), id_map.get(&es.dst)) {
                let kind = match es.kind {
                    EdgeKindSpec::Requires       => EdgeKind::Requires,
                    EdgeKindSpec::Enables        => EdgeKind::Enables,
                    EdgeKindSpec::Blocks         => EdgeKind::Blocks,
                    EdgeKindSpec::ExecutesOn     => EdgeKind::ExecutesOn,
                    EdgeKindSpec::TransformsInto => EdgeKind::TransformsInto,
                    EdgeKindSpec::Observes       => EdgeKind::Observes,
                    EdgeKindSpec::DerivesFrom    => EdgeKind::DerivesFrom,
                    EdgeKindSpec::ProjectsTo     => EdgeKind::ProjectsTo,
                    EdgeKindSpec::SwapsTo        => EdgeKind::SwapsTo,
                };
                graph.add_edge(src, dst, kind, 1.0);
            }
        }

        CIOExecutor::new(graph, PCSFOptimizer::default(), 20)
    }

    fn update_dilation(&mut self, snapshot: &ResourceSnapshot) {
        let ids: Vec<NodeId> = self.graph.nodes_by_kind(&NodeKind::Resource).iter().map(|n| n.id).collect();
        for id in ids {
            let (provider, target_lat) = match self.graph.get_node(id) {
                Some(n) => match &n.data {
                    NodeData::Resource { provider_id, latency_target_ms, .. } =>
                        (provider_id.clone(), *latency_target_ms),
                    _ => continue,
                },
                None => continue,
            };
            let health = snapshot.health.get(&provider).copied().unwrap_or(1.0);
            let lat    = snapshot.latency.get(&provider).copied().unwrap_or(target_lat);
            let ratio  = lat / target_lat.max(1.0);
            let nd = NodeDilation::from_health(health, ratio);
            if let Some(node) = self.graph.get_node_mut(id) {
                node.dilation = nd.value;
            }
        }
    }

    fn update_projections(&mut self, plan: &ExecutionPlan) {
        let active: std::collections::HashSet<NodeId> = plan.steps.iter().map(|s| s.node_id).collect();
        let proj_ids: Vec<NodeId> = self.graph.nodes_by_kind(&NodeKind::Projection).iter().map(|n| n.id).collect();
        for id in proj_ids {
            let sources: Vec<NodeId> = match self.graph.get_node(id) {
                Some(n) => match &n.data {
                    NodeData::Projection { source_node_ids, .. } => source_node_ids.clone(),
                    _ => continue,
                },
                None => continue,
            };
            let was_active = self.graph.get_node(id).map_or(false, |n| n.feature_state == FeatureState::Active);
            let now_active = sources.iter().any(|sid| active.contains(sid));
            if let Some(node) = self.graph.get_node_mut(id) {
                node.feature_state = if now_active {
                    FeatureState::Active
                } else if was_active {
                    FeatureState::Suspended
                } else {
                    node.feature_state.clone()
                };
            }
        }
    }

    /// Run the formal execution loop; returns final CIOState.
    pub fn run(&mut self, csf: &CSF) -> CIOState {
        let mut state = CIOState::default();

        // Seed resource snapshot from graph nodes
        for node in self.graph.nodes_by_kind(&NodeKind::Resource) {
            if let NodeData::Resource { provider_id, health, latency_target_ms, .. } = &node.data {
                state.resources.health.insert(provider_id.clone(), *health);
                state.resources.latency.insert(provider_id.clone(), *latency_target_ms);
            }
        }

        let mut current_plan: Option<ExecutionPlan> = None;

        for tick in 0..self.max_ticks {
            // 1. Update dilation D
            self.update_dilation(&state.resources);

            // 2. Evaluate constraints (NAP)
            let violations: Vec<String> = csf.policies.denied.clone();

            // 3. PCSF optimize/reoptimize
            let plan = if let Some(prev) = &current_plan {
                self.optimizer.reoptimize(
                    prev, &self.graph, &csf.constraints,
                    &state.resources,
                    &csf.policies.allowed_resources,
                    &csf.policies.forbidden_resources,
                )
            } else {
                self.optimizer.optimize(
                    &self.graph, &csf.constraints,
                    &state.resources,
                    &csf.policies.allowed_resources,
                    &csf.policies.forbidden_resources,
                )
            };

            // 4. Hot-swap if required
            let swap_count = if let Some(hs) = &mut self.hot_swap {
                let evts = hs.check_and_swap(
                    &mut self.graph,
                    &state.resources.health,
                    &state.resources.latency,
                    csf.constraints.max_cost,
                    tick,
                );
                hs.advance_tick();
                evts.len()
            } else { 0 };

            // 5. Update UI projections
            self.update_projections(&plan);

            // 6. Emit trace event
            let evt_text = if plan.feasible {
                plan.steps.first()
                    .map(|s| format!("execute:{}", s.node_id))
                    .unwrap_or_else(|| "execute:none".into())
            } else {
                format!("infeasible:{}", plan.infeasibility_reason)
            };
            let node_id = plan.steps.first().map(|s| s.node_id);
            let feasible = plan.feasible;

            // 7. Update M (memory)
            if let Some(step) = plan.steps.first() {
                state.memory.insert(step.node_id.to_string(), format!("tick:{tick}"));
            }

            let evt = TraceEvent {
                tick,
                event: evt_text,
                node_id,
                plan_feasible: feasible,
                swap_count,
                violations: violations.clone(),
            };
            let complete = feasible && violations.is_empty();
            state.advance(evt);
            current_plan = Some(plan);

            if complete { break; }
        }

        state
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::csf::{CSF, GraphSpec, NodeSpec, NodeKindSpec};

    #[test]
    fn executor_no_resources_does_not_complete() {
        let csf = CSF::minimal("test");
        let mut exec = CIOExecutor::from_csf(&csf);
        let state = exec.run(&csf);
        assert!(!state.complete);
        assert_eq!(state.trace.len(), exec.max_ticks as usize);
    }

    #[test]
    fn executor_completes_with_resource() {
        let mut csf = CSF::minimal("test");
        csf.graph_spec = GraphSpec {
            nodes: vec![NodeSpec {
                id:          "r1".into(),
                kind:        NodeKindSpec::Resource,
                label:       "anthropic".into(),
                provider_id: Some("anthropic".into()),
                cost:        Some(0.001),
                latency_ms:  Some(300.0),
                health:      Some(1.0),
            }],
            edges: vec![],
        };
        let mut exec = CIOExecutor::from_csf(&csf);
        let state = exec.run(&csf);
        assert!(state.complete);
        assert_eq!(state.tick, 0); // should complete on first tick
        assert!(!state.memory.is_empty());
    }

    #[test]
    fn executor_respects_nap_denial() {
        let mut csf = CSF::minimal("test");
        csf.graph_spec = GraphSpec {
            nodes: vec![NodeSpec {
                id: "r1".into(), kind: NodeKindSpec::Resource,
                label: "anthropic".into(), provider_id: Some("anthropic".into()),
                cost: Some(0.001), latency_ms: Some(300.0), health: Some(1.0),
            }],
            edges: vec![],
        };
        csf.policies.denied = vec!["no_pii".into()]; // active denial
        let mut exec = CIOExecutor::from_csf(&csf);
        let state = exec.run(&csf);
        // Plan is feasible but violations prevent completion
        assert!(!state.complete);
    }

    #[test]
    fn trace_has_one_entry_per_tick() {
        let csf = CSF::minimal("test");
        let mut exec = CIOExecutor::from_csf(&csf);
        let state = exec.run(&csf);
        assert_eq!(state.trace.len(), exec.max_ticks as usize);
    }
}
