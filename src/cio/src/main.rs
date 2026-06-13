/// CIO CLI — run the Convergence IO execution kernel from the command line.
///
/// Usage:
///     cio                  # runs a minimal demo with a single LLM resource
///     cio --help

use cio::{CSF, CIOExecutor};
use cio::csf::{GraphSpec, NodeSpec, NodeKindSpec};

fn main() {
    // Build a minimal demo CSF
    let mut csf = CSF::minimal("Demo: route a dream journal message through the convergence kernel");
    csf.graph_spec = GraphSpec {
        nodes: vec![
            NodeSpec {
                id:          "anthropic".into(),
                kind:        NodeKindSpec::Resource,
                label:       "Anthropic Claude".into(),
                provider_id: Some("anthropic".into()),
                cost:        Some(0.002),
                latency_ms:  Some(800.0),
                health:      Some(1.0),
            },
            NodeSpec {
                id:          "openai".into(),
                kind:        NodeKindSpec::Resource,
                label:       "OpenAI GPT".into(),
                provider_id: Some("openai".into()),
                cost:        Some(0.003),
                latency_ms:  Some(700.0),
                health:      Some(0.9),
            },
        ],
        edges: vec![],
    };

    println!("CIO v1.0 — Convergence IO Execution Kernel");
    println!("Intent: {}", csf.intent.text);
    println!("Max cost: ${:.3} | Max latency: {:.0}ms", csf.constraints.max_cost, csf.constraints.max_latency_ms);
    println!();

    let mut executor = CIOExecutor::from_csf(&csf);
    let state = executor.run(&csf);

    println!("Result: {}", if state.complete { "COMPLETE" } else { "INCOMPLETE" });
    println!("Ticks:  {}", state.tick + 1);
    println!("Trace entries: {}", state.trace.len());
    println!("Memory entries: {}", state.memory.len());

    if let Some(last) = state.trace.last() {
        println!("Last event: {}", last.event);
    }
}
