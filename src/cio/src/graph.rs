/// CEGGraph — Convergence Execution Graph
///
/// G = (V, E, D, τ, S, H)
///   V = typed nodes
///   E = typed directed edges
///   D = dilation field (applied externally by DilationField)
///   τ = execution time model (per-node latency targets)
///   S = CIOState
///   H = HotSwapEngine
///
/// All graph mutations are explicit; no hidden mutable state.

use std::collections::HashMap;

// ── NodeId ────────────────────────────────────────────────────────────────────

/// Opaque node identifier — cheap to copy, unique per session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(u32);

impl NodeId {
    pub fn new(id: u32) -> Self { NodeId(id) }
    pub fn raw(self) -> u32 { self.0 }
}

impl std::fmt::Display for NodeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "node-{}", self.0)
    }
}

// ── Node taxonomy ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum NodeKind {
    Intent,
    Resource,
    Constraint,
    Authority,
    Memory,
    Trace,
    Projection,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResourceKind { LLM, VM, Tool, Agent }

#[derive(Debug, Clone, PartialEq)]
pub enum Severity { Soft, Hard, Critical }

#[derive(Debug, Clone, PartialEq)]
pub enum FeatureState { Inactive, Scheduled, Active, Suspended }

/// A single graph node — discriminated union over all node types.
#[derive(Debug, Clone)]
pub struct Node {
    pub id:    NodeId,
    pub kind:  NodeKind,
    pub label: String,
    /// Time dilation value D(v) — updated each tick.
    pub dilation: f64,
    /// Lifecycle state (meaningful for Resource + Projection nodes).
    pub feature_state: FeatureState,
    /// Node-kind-specific data.
    pub data: NodeData,
}

/// Kind-specific payload, keeping Node small for the common case.
#[derive(Debug, Clone)]
pub enum NodeData {
    Intent {
        raw_text:  String,
        embedding: Vec<f32>,
    },
    Resource {
        resource_kind:    ResourceKind,
        provider_id:      String,
        capabilities:     Vec<String>,
        cost_per_token:   f64,
        latency_target_ms: f64,
        health:           f64,
    },
    Constraint {
        predicate: String,
        scope:     String,
        severity:  Severity,
        satisfied: Option<bool>,
    },
    Authority {
        policy_set:     Vec<String>,
        identity_scope: String,
    },
    Memory {
        content:       String,
        provenance:    String,
        access_policy: String,
    },
    Trace {
        event:             String,
        causal_parent_id:  Option<NodeId>,
        actor_node_id:     Option<NodeId>,
        timestamp_ms:      u64,
    },
    Projection {
        view_type:       String,
        filter:          String,
        render_policy:   String,
        source_node_ids: Vec<NodeId>,
    },
}

// ── Edge taxonomy ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EdgeKind {
    Requires,
    Enables,
    Blocks,
    ExecutesOn,
    TransformsInto,
    Observes,
    DerivesFrom,
    ProjectsTo,
    SwapsTo,
}

#[derive(Debug, Clone)]
pub struct Edge {
    pub src:    NodeId,
    pub dst:    NodeId,
    pub kind:   EdgeKind,
    pub weight: f64,
}

// ── CEGGraph ──────────────────────────────────────────────────────────────────

/// Mutable execution graph.
///
/// v1.0: single-threaded; v1.1 adds interior mutability + async.
#[derive(Debug, Default)]
pub struct CEGGraph {
    nodes:       HashMap<NodeId, Node>,
    edges:       Vec<Edge>,
    next_id:     u32,
}

impl CEGGraph {
    pub fn new() -> Self { Self::default() }

    /// Add a node; return its assigned NodeId.
    pub fn add_node(&mut self, kind: NodeKind, label: impl Into<String>, data: NodeData) -> NodeId {
        let id = NodeId::new(self.next_id);
        self.next_id += 1;
        self.nodes.insert(id, Node {
            id,
            kind,
            label: label.into(),
            dilation: 1.0,
            feature_state: FeatureState::Inactive,
            data,
        });
        id
    }

    /// Remove a node and all edges referencing it. Returns the removed node.
    pub fn remove_node(&mut self, id: NodeId) -> Option<Node> {
        let node = self.nodes.remove(&id)?;
        self.edges.retain(|e| e.src != id && e.dst != id);
        Some(node)
    }

    /// σ: v_old → v_new — atomic node replacement with edge rewiring.
    ///
    /// All edges referencing `old_id` are repointed to `new_id`.
    /// The old node is returned; the new node must already be in the graph.
    pub fn swap_nodes(&mut self, old_id: NodeId, new_id: NodeId) -> Option<Node> {
        let old = self.nodes.remove(&old_id)?;
        // Rewire edges
        for edge in &mut self.edges {
            if edge.src == old_id { edge.src = new_id; }
            if edge.dst == old_id { edge.dst = new_id; }
        }
        Some(old)
    }

    pub fn add_edge(&mut self, src: NodeId, dst: NodeId, kind: EdgeKind, weight: f64) {
        self.edges.push(Edge { src, dst, kind, weight });
    }

    pub fn get_node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn get_node_mut(&mut self, id: NodeId) -> Option<&mut Node> {
        self.nodes.get_mut(&id)
    }

    pub fn nodes_by_kind(&self, kind: &NodeKind) -> Vec<&Node> {
        self.nodes.values().filter(|n| &n.kind == kind).collect()
    }

    pub fn edges_from(&self, src: NodeId) -> Vec<&Edge> {
        self.edges.iter().filter(|e| e.src == src).collect()
    }

    pub fn edges_to(&self, dst: NodeId) -> Vec<&Edge> {
        self.edges.iter().filter(|e| e.dst == dst).collect()
    }

    pub fn node_count(&self) -> usize { self.nodes.len() }
    pub fn edge_count(&self) -> usize { self.edges.len() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent_data() -> NodeData {
        NodeData::Intent { raw_text: "test".into(), embedding: vec![] }
    }

    fn resource_data(provider: &str) -> NodeData {
        NodeData::Resource {
            resource_kind: ResourceKind::LLM,
            provider_id: provider.into(),
            capabilities: vec!["chat".into()],
            cost_per_token: 0.001,
            latency_target_ms: 500.0,
            health: 1.0,
        }
    }

    #[test]
    fn add_and_get_node() {
        let mut g = CEGGraph::new();
        let id = g.add_node(NodeKind::Intent, "test", intent_data());
        assert!(g.get_node(id).is_some());
        assert_eq!(g.node_count(), 1);
    }

    #[test]
    fn remove_node_clears_edges() {
        let mut g = CEGGraph::new();
        let a = g.add_node(NodeKind::Intent, "a", intent_data());
        let b = g.add_node(NodeKind::Resource, "b", resource_data("anthropic"));
        g.add_edge(a, b, EdgeKind::ExecutesOn, 1.0);
        g.remove_node(a);
        assert_eq!(g.edge_count(), 0);
    }

    #[test]
    fn swap_nodes_rewires_edges() {
        let mut g = CEGGraph::new();
        let intent = g.add_node(NodeKind::Intent, "i", intent_data());
        let old = g.add_node(NodeKind::Resource, "old", resource_data("anthropic"));
        let new = g.add_node(NodeKind::Resource, "new", resource_data("openai"));
        g.add_edge(intent, old, EdgeKind::ExecutesOn, 1.0);

        let removed = g.swap_nodes(old, new);
        assert!(removed.is_some());
        assert!(g.get_node(old).is_none());

        let edges = g.edges_from(intent);
        assert!(edges.iter().any(|e| e.dst == new));
        assert!(edges.iter().all(|e| e.dst != old));
    }

    #[test]
    fn nodes_by_kind() {
        let mut g = CEGGraph::new();
        g.add_node(NodeKind::Resource, "r1", resource_data("anthropic"));
        g.add_node(NodeKind::Resource, "r2", resource_data("openai"));
        g.add_node(NodeKind::Intent, "i", intent_data());
        assert_eq!(g.nodes_by_kind(&NodeKind::Resource).len(), 2);
        assert_eq!(g.nodes_by_kind(&NodeKind::Intent).len(), 1);
    }

    #[test]
    fn dilation_field_defaults_to_one() {
        let mut g = CEGGraph::new();
        let id = g.add_node(NodeKind::Resource, "r", resource_data("anthropic"));
        assert_eq!(g.get_node(id).unwrap().dilation, 1.0);
    }
}
