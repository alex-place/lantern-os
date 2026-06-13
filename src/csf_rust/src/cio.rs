//! cio.rs — Convergence IO Engine v1.0, Rust reference implementation
//!
//! Typed execution kernel for a constraint-driven, graph-based runtime where
//! PCSF and CIO operate over a mutable computation graph with traceable state
//! transitions.
//!
//! See issue #391 for the formal spec and design contracts.
//!
//! ## What is intentionally NOT in 1.0
//! - No async runtime (Tokio not introduced)
//! - No real LLM backend binding
//! - No distributed execution
//! - No probabilistic planner
//! - No full hot-swap safety proofs

use std::collections::HashMap;

// ─────────────────────────────────────────────────────────────────────────────
// Node/Edge types
// ─────────────────────────────────────────────────────────────────────────────

pub type NodeId = String;

/// All node categories in a Convergence Execution Graph.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Intent,
    Resource,
    Tool,
    Memory,
    Constraint,
    Trace,
}

/// Directed edge semantics between two nodes.
#[derive(Debug, Clone, PartialEq)]
pub enum EdgeType {
    Requires,
    Enables,
    Blocks,
    ExecutesOn,
    TransformsInto,
    Observes,
}

/// A directed edge in the execution graph.
#[derive(Debug, Clone)]
pub struct Edge {
    pub from:      NodeId,
    pub to:        NodeId,
    pub edge_type: EdgeType,
}

/// The Convergence Execution Graph — mutable, traceable.
#[derive(Debug, Clone, Default)]
pub struct GraphSpec {
    pub nodes: HashMap<NodeId, Node>,
    pub edges: Vec<Edge>,
}

impl GraphSpec {
    pub fn new() -> Self { Self::default() }

    pub fn add_node(&mut self, id: impl Into<NodeId>, node: Node) {
        self.nodes.insert(id.into(), node);
    }

    pub fn add_edge(&mut self, from: impl Into<NodeId>, to: impl Into<NodeId>, edge_type: EdgeType) {
        self.edges.push(Edge { from: from.into(), to: to.into(), edge_type });
    }

    /// Returns all node IDs that are blocked by `blocker`.
    pub fn blocked_by(&self, blocker: &str) -> Vec<&NodeId> {
        self.edges.iter()
            .filter(|e| e.from == blocker && e.edge_type == EdgeType::Blocks)
            .map(|e| &e.to)
            .collect()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSF — Convergence Standard Format (typed input schema)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Intent {
    pub description:   String,
    pub priority:      u8,          // 0 (lowest) – 10 (highest)
    pub deadline_ms:   Option<u64>, // Optional wall-clock deadline
}

#[derive(Debug, Clone, Default)]
pub struct Context {
    pub session_id: String,
    pub persona_id: String,
    pub metadata:   HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct Constraints {
    pub max_tokens:     Option<u32>,
    pub max_latency_ms: Option<u64>,
    pub required_tools: Vec<String>,
    pub blocked_tools:  Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Policies {
    pub allow_hot_swap:      bool,
    pub require_consensus:   bool,
    pub observability_level: ObservabilityLevel,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub enum ObservabilityLevel {
    Silent,
    #[default]
    Trace,
    Debug,
    Full,
}

#[derive(Debug, Clone, Default)]
pub struct Observability {
    pub level:       ObservabilityLevel,
    pub trace_sink:  Option<String>,
}

/// The top-level CSF document — all CIO inputs in one typed structure.
#[derive(Debug, Clone)]
pub struct CSF {
    pub intent:        Intent,
    pub context:       Context,
    pub constraints:   Constraints,
    pub graph_spec:    GraphSpec,
    pub policies:      Policies,
    pub observability: Observability,
}

impl CSF {
    pub fn new(description: impl Into<String>, priority: u8) -> Self {
        CSF {
            intent:        Intent { description: description.into(), priority, deadline_ms: None },
            context:       Context::default(),
            constraints:   Constraints::default(),
            graph_spec:    GraphSpec::new(),
            policies:      Policies::default(),
            observability: Observability::default(),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime state
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct ResourceState {
    pub available: HashMap<String, bool>,
    pub usage:     HashMap<String, f32>,
}

#[derive(Debug, Clone, Default)]
pub struct MemoryState {
    pub entries: Vec<MemoryEntry>,
}

#[derive(Debug, Clone)]
pub struct MemoryEntry {
    pub key:       String,
    pub value:     String,
    pub tier:      u8,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Default)]
pub struct PolicyState {
    pub active_policies: Vec<String>,
    pub violations:      Vec<String>,
}

/// Full CIO runtime state: S(t) = (G, R, M, P)
#[derive(Debug, Clone, Default)]
pub struct CIOState {
    pub graph:    GraphSpec,
    pub resources: ResourceState,
    pub memory:   MemoryState,
    pub policies: PolicyState,
    pub tick:     u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// PCSF Scheduler (stub)
// ─────────────────────────────────────────────────────────────────────────────

/// An ordered list of nodes to execute, plus per-node resource allocations.
#[derive(Debug, Clone, Default)]
pub struct ExecutionPlan {
    pub steps:           Vec<NodeId>,
    pub resource_grants: HashMap<NodeId, HashMap<String, f32>>,
    pub estimated_ms:    u64,
}

/// PCSF scheduler — stub returning a greedy execution plan.
/// Future: replace with cost-gradient optimizer.
pub struct PCSFScheduler;

impl PCSFScheduler {
    pub fn optimize(&self, csf: &CSF, _state: &CIOState) -> ExecutionPlan {
        // Greedy: schedule all non-blocked intent nodes in insertion order.
        let blocked: Vec<&NodeId> = csf.graph_spec.edges.iter()
            .filter(|e| e.edge_type == EdgeType::Blocks)
            .map(|e| &e.to)
            .collect();

        let steps: Vec<NodeId> = csf.graph_spec.nodes.keys()
            .filter(|id| !blocked.contains(id))
            .cloned()
            .collect();

        ExecutionPlan {
            steps,
            resource_grants: HashMap::new(),
            estimated_ms: 0,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Time dilation
// ─────────────────────────────────────────────────────────────────────────────

/// Compute a time-dilation factor from uncertainty, cost pressure, and confidence.
/// Returns a multiplier in [0.1, 10.0] — higher = more dilated / slower execution.
///
/// # Arguments
/// * `uncertainty`    — 0.0 (certain) to 1.0 (fully uncertain)
/// * `cost_pressure`  — 0.0 (free) to 1.0 (budget exhausted)
/// * `confidence`     — 0.0 (no confidence) to 1.0 (full confidence)
pub fn dilation(uncertainty: f32, cost_pressure: f32, confidence: f32) -> f32 {
    let raw = (1.0 + uncertainty) * (1.0 + cost_pressure) / (0.1 + confidence);
    raw.clamp(0.1, 10.0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Hot-swap engine
// ─────────────────────────────────────────────────────────────────────────────

/// Replace a node in-place on a live graph, preserving all edges.
/// Panics if `old_id` does not exist.
pub fn swap_nodes(graph: &mut GraphSpec, old_id: &str, new_id: impl Into<NodeId>, new_node: Node) {
    let new_id: NodeId = new_id.into();
    assert!(
        graph.nodes.remove(old_id).is_some(),
        "swap_nodes: node '{}' not found in graph",
        old_id
    );
    graph.nodes.insert(new_id.clone(), new_node);

    // Rewrite all edges that reference old_id
    for edge in graph.edges.iter_mut() {
        if edge.from == old_id { edge.from = new_id.clone(); }
        if edge.to   == old_id { edge.to   = new_id.clone(); }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CIO execution kernel
// ─────────────────────────────────────────────────────────────────────────────

/// CIO execution result for a single step.
#[derive(Debug, Clone)]
pub enum StepResult {
    Ok { node_id: NodeId, duration_ms: u64 },
    Skipped { node_id: NodeId, reason: String },
    Failed { node_id: NodeId, error: String },
}

/// The CIO execution engine.
pub struct CIO {
    pub scheduler: PCSFScheduler,
}

impl CIO {
    pub fn new() -> Self { CIO { scheduler: PCSFScheduler } }

    /// Run the CIO execution loop: plan → execute → record → return final state.
    ///
    /// This is a synchronous skeleton; no async I/O or real LLM calls.
    /// Each step logs to `CIOState::memory` via `MemoryEntry`.
    pub fn run(&self, csf: CSF) -> CIOState {
        let mut state = CIOState {
            graph: csf.graph_spec.clone(),
            ..Default::default()
        };

        let plan = self.scheduler.optimize(&csf, &state);
        let dil  = dilation(0.2, 0.1, 0.8); // baseline dilation factor

        for (i, node_id) in plan.steps.iter().enumerate() {
            let node = state.graph.nodes.get(node_id);
            let result = match node {
                None => StepResult::Skipped {
                    node_id: node_id.clone(),
                    reason: "node not in runtime graph".into(),
                },
                Some(_) => StepResult::Ok {
                    node_id: node_id.clone(),
                    duration_ms: (10.0 * dil) as u64,
                },
            };

            // Trace to memory
            let trace_line = match &result {
                StepResult::Ok { node_id, duration_ms } =>
                    format!("ok:{}:{}ms", node_id, duration_ms),
                StepResult::Skipped { node_id, reason } =>
                    format!("skip:{}:{}", node_id, reason),
                StepResult::Failed { node_id, error } =>
                    format!("fail:{}:{}", node_id, error),
            };

            state.memory.entries.push(MemoryEntry {
                key:       format!("cio.step.{}", i),
                value:     trace_line,
                tier:      2,
                timestamp: i as u64,
            });
            state.tick += 1;
        }

        state
    }
}

impl Default for CIO {
    fn default() -> Self { Self::new() }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn basic_csf() -> CSF {
        let mut csf = CSF::new("test intent", 5);
        csf.graph_spec.add_node("node_a", Node::Intent);
        csf.graph_spec.add_node("node_b", Node::Tool);
        csf.graph_spec.add_edge("node_a", "node_b", EdgeType::Enables);
        csf
    }

    #[test] fn csf_constructs() {
        let csf = basic_csf();
        assert_eq!(csf.intent.priority, 5);
        assert_eq!(csf.graph_spec.nodes.len(), 2);
    }

    #[test] fn graph_edges() {
        let csf = basic_csf();
        assert_eq!(csf.graph_spec.edges.len(), 1);
        assert_eq!(csf.graph_spec.edges[0].edge_type, EdgeType::Enables);
    }

    #[test] fn blocked_by_returns_correct_nodes() {
        let mut g = GraphSpec::new();
        g.add_node("blocker", Node::Constraint);
        g.add_node("victim",  Node::Tool);
        g.add_edge("blocker", "victim", EdgeType::Blocks);
        let blocked = g.blocked_by("blocker");
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0], "victim");
    }

    #[test] fn dilation_range() {
        assert!(dilation(0.0, 0.0, 1.0) >= 0.1);
        assert!(dilation(1.0, 1.0, 0.0) <= 10.0);
        let d = dilation(0.2, 0.1, 0.8);
        assert!(d > 0.1 && d < 10.0);
    }

    #[test] fn dilation_monotone_in_uncertainty() {
        let low  = dilation(0.0, 0.0, 1.0);
        let high = dilation(1.0, 0.0, 1.0);
        assert!(high > low, "higher uncertainty should increase dilation");
    }

    #[test] fn swap_nodes_rewrites_edges() {
        let mut g = GraphSpec::new();
        g.add_node("old", Node::Tool);
        g.add_node("dep", Node::Resource);
        g.add_edge("old", "dep", EdgeType::Requires);
        swap_nodes(&mut g, "old", "new", Node::Tool);
        assert!(g.nodes.contains_key("new"));
        assert!(!g.nodes.contains_key("old"));
        assert_eq!(g.edges[0].from, "new");
    }

    #[test] fn cio_run_produces_state() {
        let csf   = basic_csf();
        let cio   = CIO::new();
        let state = cio.run(csf);
        assert!(state.tick > 0, "tick should advance after execution");
        assert!(!state.memory.entries.is_empty(), "trace entries should exist");
    }

    #[test] fn cio_run_traces_all_unblocked_steps() {
        let mut csf = CSF::new("multi-node", 3);
        csf.graph_spec.add_node("n1", Node::Intent);
        csf.graph_spec.add_node("n2", Node::Tool);
        csf.graph_spec.add_node("blocked", Node::Constraint);
        csf.graph_spec.add_edge("n1", "blocked", EdgeType::Blocks);
        let state = CIO::new().run(csf);
        // n1 and n2 run; blocked is skipped by scheduler
        assert_eq!(state.memory.entries.len(), 2);
    }

    #[test] fn pcsf_scheduler_excludes_blocked_nodes() {
        let mut csf = CSF::new("sched-test", 1);
        csf.graph_spec.add_node("free",    Node::Tool);
        csf.graph_spec.add_node("blocked", Node::Resource);
        csf.graph_spec.add_edge("free", "blocked", EdgeType::Blocks);
        let plan = PCSFScheduler.optimize(&csf, &CIOState::default());
        assert!(!plan.steps.contains(&"blocked".to_string()));
        assert!(plan.steps.contains(&"free".to_string()));
    }
}