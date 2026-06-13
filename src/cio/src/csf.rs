/// CSF — Convergence Standard Format
///
/// Typed input schema for all CIO operations.
/// Every execution begins with a CSF instance that declares intent,
/// context, constraints, graph spec, policies, and observability config.

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
    /// Construct a minimal CSF for testing/prototyping.
    pub fn minimal(intent_text: impl Into<String>) -> Self {
        CSF {
            intent:        Intent { text: intent_text.into(), embedding: vec![] },
            context:       Context::default(),
            constraints:   Constraints::default(),
            graph_spec:    GraphSpec::default(),
            policies:      Policies::default(),
            observability: Observability::default(),
        }
    }
}

// ── Intent ────────────────────────────────────────────────────────────────────

/// The goal of this execution — what the caller wants to accomplish.
#[derive(Debug, Clone, Default)]
pub struct Intent {
    /// Human-readable goal description.
    pub text: String,
    /// Optional CSF embedding vector (empty in v1.0).
    pub embedding: Vec<f32>,
}

// ── Context ───────────────────────────────────────────────────────────────────

/// Runtime context enriching the intent — session, persona, recent memory.
#[derive(Debug, Clone, Default)]
pub struct Context {
    pub session_id: String,
    pub persona_id: String,
    /// Recent memory snippets injected into context window.
    pub memory_snippets: Vec<String>,
    /// Previous conversation turns (message, role pairs).
    pub history: Vec<(String, String)>,
}

// ── Constraints ───────────────────────────────────────────────────────────────

/// Hard limits that the PCSF optimizer must satisfy.
/// Constraint dominance invariant: violations abort execution, never warn.
#[derive(Debug, Clone)]
pub struct Constraints {
    /// Maximum USD cost per request (e.g. 0.05).
    pub max_cost: f64,
    /// Maximum end-to-end latency in milliseconds.
    pub max_latency_ms: f64,
    /// Require reproducible output under identical state.
    pub determinism: bool,
    /// Data boundary: "internal" | "operator" | "public".
    pub memory_policy: String,
    /// External I/O policy: "allow" | "block" | "audit".
    pub external_io_policy: String,
}

impl Default for Constraints {
    fn default() -> Self {
        Constraints {
            max_cost:           0.05,
            max_latency_ms:     10_000.0,
            determinism:        false,
            memory_policy:      "internal".into(),
            external_io_policy: "allow".into(),
        }
    }
}

// ── GraphSpec ─────────────────────────────────────────────────────────────────

/// Declarative graph structure — nodes and edges to instantiate.
#[derive(Debug, Clone, Default)]
pub struct GraphSpec {
    pub nodes: Vec<NodeSpec>,
    pub edges: Vec<EdgeSpec>,
}

/// Specification for a single node.
#[derive(Debug, Clone)]
pub struct NodeSpec {
    pub id:          String,
    pub kind:        NodeKindSpec,
    pub label:       String,
    pub provider_id: Option<String>,
    pub cost:        Option<f64>,
    pub latency_ms:  Option<f64>,
    pub health:      Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NodeKindSpec {
    Intent,
    Resource,
    Constraint,
    Authority,
    Memory,
    Trace,
    Projection,
}

/// Specification for a single edge.
#[derive(Debug, Clone)]
pub struct EdgeSpec {
    pub src: String,
    pub dst: String,
    pub kind: EdgeKindSpec,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EdgeKindSpec {
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

// ── Policies ──────────────────────────────────────────────────────────────────

/// NAP (Negative Authority Profile) + authority scope policies.
#[derive(Debug, Clone, Default)]
pub struct Policies {
    /// Predicates that are explicitly denied (NAP).
    pub denied: Vec<String>,
    /// Identity scope: "operator" | "user" | "agent" | "public".
    pub identity_scope: String,
    /// Allowed provider IDs (empty = all allowed).
    pub allowed_resources: Vec<String>,
    /// Forbidden provider IDs.
    pub forbidden_resources: Vec<String>,
}

// ── Observability ─────────────────────────────────────────────────────────────

/// Trace and metrics configuration for the execution run.
#[derive(Debug, Clone, Default)]
pub struct Observability {
    /// Emit a TraceEvent for every execution step.
    pub trace_enabled: bool,
    /// Path to append JSONL trace records (empty = no file output).
    pub trace_path: String,
    /// Include latency measurements in trace events.
    pub latency_tracking: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csf_minimal_constructs() {
        let csf = CSF::minimal("test intent");
        assert_eq!(csf.intent.text, "test intent");
        assert!(csf.intent.embedding.is_empty());
        assert_eq!(csf.constraints.max_cost, 0.05);
    }

    #[test]
    fn constraints_default_sane() {
        let c = Constraints::default();
        assert!(c.max_cost > 0.0);
        assert!(c.max_latency_ms > 0.0);
        assert!(!c.determinism);
    }
}
