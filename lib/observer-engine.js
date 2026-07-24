"use strict";

/**
 * Observer Engine 1.0 — Knowability Field
 *
 * Models the observer not as a single state object but as a continuously
 * updated Knowability Field: where the edge of possible awareness is,
 * not just what is currently known.
 *
 * K(t) = Known ∪ Recallable ∪ Observable ∪ Reachable ∪ Inferable ∪ Discoverable
 *
 * Band(t,Δt) = ⋃ K(x) for x ∈ [t, t+Δt]
 * CSF = Intersection(BandA, BandB, ...)
 *
 * Connection to Impossibility Engine:
 *   - constraint elimination = shrinking discoverable set
 *   - "remaining states" = known ∪ inferable after constraints apply
 *   - tight-band files = TemporalBand snapshots
 *   - csf_cache/ = ConvergenceStateField persistence
 *
 * update_frontier() is incremental BFS: delta frontier per tick, not full recompute.
 * At 60Hz this traversal must cost O(changed edges), not O(total graph).
 */

// ── Types (documented as constants for JS consumers) ─────────────────────────

const KnowledgeClass = {
  Known:       "Known",       // Active awareness
  Recallable:  "Recallable",  // Stored memory, retrieval cost
  Observable:  "Observable",  // Sensor-accessible, low latency
  Reachable:   "Reachable",   // Obtainable through action
  Inferable:   "Inferable",   // Logically derivable from known set
  Discoverable:"Discoverable",// Unknown but investigable
};

// Cost thresholds (ms) for BFS classification
const CLASS_LATENCY_MS = {
  Known:        0,
  Recallable:   50,
  Observable:   100,
  Reachable:    500,
  Inferable:    1000,
  Discoverable: Infinity,
};

// ── KnowableState ─────────────────────────────────────────────────────────────

class KnowableState {
  constructor({ id, klass, confidence = 1.0, timestampNs = BigInt(Date.now()) * 1_000_000n, entropy = 0, payload }) {
    this.id          = id;
    this.klass       = klass;
    this.confidence  = confidence;
    this.timestampNs = timestampNs;
    this.entropy     = entropy;
    this.payload     = payload; // { type: 'Fact'|'Observation'|'MemoryRef'|'Url'|'Custom', value }
  }
}

// ── InformationGraph (nodes + edges with cost/latency) ────────────────────────

class InformationGraph {
  constructor() {
    this.nodes = new Map(); // id → KnowableState
    this.edges = [];        // { source, target, cost, latencyMs }
    this._adj  = new Map(); // source → [{ target, cost, latencyMs }]
  }

  addNode(state) {
    this.nodes.set(state.id, state);
    return this;
  }

  addEdge(source, target, cost = 1.0, latencyMs = 50) {
    this.edges.push({ source, target, cost, latencyMs });
    if (!this._adj.has(source)) this._adj.set(source, []);
    this._adj.get(source).push({ target, cost, latencyMs });
    return this;
  }

  neighbors(id) {
    return this._adj.get(id) || [];
  }
}

// ── KnowabilityFrontier ───────────────────────────────────────────────────────

class KnowabilityFrontier {
  constructor(observerId) {
    this.observerId  = observerId;
    // 6-class frontier, matching KnowledgeClass enum exactly
    this.known        = new Set();
    this.recallable   = new Set();
    this.observable   = new Set();
    this.reachable    = new Set();
    this.inferable    = new Set();
    this.discoverable = new Set();
  }

  /** Place a state id into the correct bucket based on latency. */
  classify(id, latencyMs) {
    // Remove from any existing bucket first (promotion)
    this.discoverable.delete(id);
    this.inferable.delete(id);
    this.reachable.delete(id);
    this.observable.delete(id);
    this.recallable.delete(id);
    this.known.delete(id);

    if (latencyMs <= CLASS_LATENCY_MS.Known)       this.known.add(id);
    else if (latencyMs <= CLASS_LATENCY_MS.Recallable)  this.recallable.add(id);
    else if (latencyMs <= CLASS_LATENCY_MS.Observable)  this.observable.add(id);
    else if (latencyMs <= CLASS_LATENCY_MS.Reachable)   this.reachable.add(id);
    else if (latencyMs < CLASS_LATENCY_MS.Discoverable) this.inferable.add(id);
    else this.discoverable.add(id);
  }

  /** All state ids currently on the frontier (any bucket). */
  allIds() {
    return new Set([
      ...this.known, ...this.recallable, ...this.observable,
      ...this.reachable, ...this.inferable, ...this.discoverable,
    ]);
  }

  /** Eliminate a state (constraint applied — it's impossible). */
  eliminate(id) {
    for (const bucket of [this.known, this.recallable, this.observable,
                           this.reachable, this.inferable, this.discoverable]) {
      bucket.delete(id);
    }
  }

  toJSON() {
    return {
      observerId:   this.observerId,
      known:        [...this.known],
      recallable:   [...this.recallable],
      observable:   [...this.observable],
      reachable:    [...this.reachable],
      inferable:    [...this.inferable],
      discoverable: [...this.discoverable],
    };
  }
}

// ── TemporalBand ──────────────────────────────────────────────────────────────

class TemporalBand {
  constructor(startNs, endNs) {
    this.startNs = startNs;
    this.endNs   = endNs;
    this.states  = [];   // KnowableState[]
  }

  add(state) {
    this.states.push(state);
    return this;
  }

  /** Union of all state ids in this band. */
  stateIds() {
    return new Set(this.states.map(s => s.id));
  }

  toJSON() {
    return {
      startNs: this.startNs.toString(),
      endNs:   this.endNs.toString(),
      count:   this.states.length,
      states:  this.states.map(s => ({ id: s.id, klass: s.klass, confidence: s.confidence })),
    };
  }
}

// ── ObserverState ─────────────────────────────────────────────────────────────

class ObserverState {
  constructor(observerId, bandDurationMs = 60_000) {
    this.observerId     = observerId;
    this.bandDurationMs = bandDurationMs;
    this.graph          = new InformationGraph();
    this.frontier       = new KnowabilityFrontier(observerId);
    this._band          = null;
    this._tickRateHz    = 60;
    this._tickIntervalMs = Math.round(1000 / this._tickRateHz);
    this._timer         = null;
    this._dirtyNodes    = new Set(); // incremental: only re-traverse changed subgraph
  }

  /** Seed the graph with initial known states. */
  seed(states) {
    for (const s of states) {
      this.graph.addNode(s);
      this.frontier.classify(s.id, 0); // seeded states are immediately Known
      this._dirtyNodes.add(s.id);
    }
    return this;
  }

  /** Connect two states with an information edge. */
  link(sourceId, targetId, latencyMs, cost = 1.0) {
    this.graph.addEdge(sourceId, targetId, cost, latencyMs);
    this._dirtyNodes.add(sourceId);
    return this;
  }

  /**
   * update_frontier() — incremental Dijkstra from dirty nodes.
   * Classifies newly-reachable states by cumulative latency bucket.
   * Only traverses subgraph reachable from changed nodes.
   */
  update_frontier() {
    if (this._dirtyNodes.size === 0) return;

    // Dijkstra: priority queue seeded with dirty known states
    // dist = cumulative latency in ms
    const dist = new Map();
    const queue = []; // [latencyMs, id]

    for (const id of this._dirtyNodes) {
      dist.set(id, 0);
      queue.push([0, id]);
    }
    this._dirtyNodes.clear();

    // Simple priority sort (small graph: heapify not needed)
    queue.sort((a, b) => a[0] - b[0]);

    while (queue.length > 0) {
      const [d, id] = queue.shift();
      if ((dist.get(id) ?? Infinity) < d) continue; // stale

      this.frontier.classify(id, d);

      for (const { target, latencyMs } of this.graph.neighbors(id)) {
        const nd = d + latencyMs;
        if (nd < (dist.get(target) ?? Infinity)) {
          dist.set(target, nd);
          queue.push([nd, target]);
          queue.sort((a, b) => a[0] - b[0]);
        }
      }
    }
  }

  /** Emit the current temporal band. */
  emit_band() {
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const startNs = nowNs - BigInt(this.bandDurationMs) * 1_000_000n;
    const band = new TemporalBand(startNs, nowNs);

    for (const [id, state] of this.graph.nodes) {
      const f = this.frontier;
      const klass = f.known.has(id)        ? KnowledgeClass.Known
                  : f.recallable.has(id)   ? KnowledgeClass.Recallable
                  : f.observable.has(id)   ? KnowledgeClass.Observable
                  : f.reachable.has(id)    ? KnowledgeClass.Reachable
                  : f.inferable.has(id)    ? KnowledgeClass.Inferable
                  : KnowledgeClass.Discoverable;
      band.add(new KnowableState({
        id, klass,
        confidence: state.confidence,
        timestampNs: nowNs,
        entropy: state.entropy,
        payload: state.payload,
      }));
    }
    this._band = band;
    return band;
  }

  /** Apply an Impossibility Engine result: eliminate impossible states from discoverable. */
  apply_ie_result(ieResult) {
    // IE constraint elimination = pruning discoverable
    if (ieResult.determined) {
      // If fully determined, all states except the known side are eliminated
      // from discoverable — nothing left to discover
      for (const id of [...this.frontier.discoverable]) {
        this.frontier.eliminate(id);
      }
    }
    return this;
  }

  start(tickRateHz = 60) {
    this._tickRateHz = tickRateHz;
    this._tickIntervalMs = Math.round(1000 / tickRateHz);
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      this.update_frontier();
    }, this._tickIntervalMs);
    return this;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

// ── ConvergenceStateField ─────────────────────────────────────────────────────
// CSF = intersection of TemporalBands from multiple observers.
// shared_states is exactly what csf_cache/ already stores.

class ConvergenceStateField {
  constructor(bands = []) {
    this.timestampNs            = BigInt(Date.now()) * 1_000_000n;
    this.participatingObservers = [];
    this.overlapScore           = 0;
    this.sharedStates           = new Set();
    if (bands.length > 0) this.compute(bands);
  }

  compute(bands) {
    if (bands.length === 0) { this.overlapScore = 0; return this; }
    this.participatingObservers = bands.map((b, i) => i);

    // Intersection of all band state-id sets
    let shared = bands[0].stateIds();
    for (let i = 1; i < bands.length; i++) {
      const ids = bands[i].stateIds();
      for (const id of shared) { if (!ids.has(id)) shared.delete(id); }
    }
    this.sharedStates = shared;

    // Overlap score: |intersection| / |union|
    const union = new Set();
    for (const b of bands) for (const id of b.stateIds()) union.add(id);
    this.overlapScore = union.size > 0 ? shared.size / union.size : 0;
    return this;
  }

  toJSON() {
    return {
      timestampNs:            this.timestampNs.toString(),
      participatingObservers: this.participatingObservers,
      overlapScore:           +this.overlapScore.toFixed(4),
      sharedStateCount:       this.sharedStates.size,
      sharedStates:           [...this.sharedStates].slice(0, 100), // cap for wire
    };
  }
}

// ── Kalshi market → Observer Engine integration ───────────────────────────────
// Builds an ObserverState from a set of Kalshi markets.
// Each market is a KnowableState; edges connect overlapping/related markets.

function buildKalshiObserver(markets, ieResults = []) {
  const observer = new ObserverState("kalshi-observer");
  const ieMap = new Map(ieResults.map(r => [r.ticker, r]));

  // Seed: each market is a state
  for (const m of markets) {
    const ie = ieMap.get(m.ticker);
    const klass = ie
      ? (ie.determined ? KnowledgeClass.Known : ie.confident ? KnowledgeClass.Inferable : KnowledgeClass.Discoverable)
      : KnowledgeClass.Observable;

    const state = new KnowableState({
      id:         m.ticker,
      klass,
      confidence: ie ? ie.confidence / 100 : 0.5,
      timestampNs: BigInt(Date.now()) * 1_000_000n,
      entropy:    ie ? (ie.validRange?.width ?? 100) / 100 : 1.0,
      payload:    { type: "Observation", value: { yes_ask: m.yes_ask, close_time: m.close_time } },
    });
    observer.graph.addNode(state);
    // Seed known/inferable immediately; let BFS handle reachable/discoverable
    observer.frontier.classify(m.ticker, klass === KnowledgeClass.Known ? 0
                                        : klass === KnowledgeClass.Inferable ? CLASS_LATENCY_MS.Reachable + 1
                                        : CLASS_LATENCY_MS.Observable + 1);
  }

  // Edges: markets in the same event are related (low latency = 20ms)
  const byEvent = new Map();
  for (const m of markets) {
    const ev = m.event_ticker || m.ticker.split("-").slice(0, 2).join("-");
    if (!byEvent.has(ev)) byEvent.set(ev, []);
    byEvent.get(ev).push(m.ticker);
  }
  for (const [, group] of byEvent) {
    for (let i = 0; i < group.length - 1; i++) {
      observer.link(group[i], group[i + 1], 20, 0.5);
    }
  }

  // Apply IE results: determined markets collapse discoverable set
  for (const ie of ieResults) {
    if (ie.determined) observer.apply_ie_result(ie);
  }

  observer.update_frontier();
  return observer;
}

module.exports = {
  KnowledgeClass,
  CLASS_LATENCY_MS,
  KnowableState,
  InformationGraph,
  KnowabilityFrontier,
  TemporalBand,
  ObserverState,
  ConvergenceStateField,
  buildKalshiObserver,
};
