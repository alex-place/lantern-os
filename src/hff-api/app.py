#!/usr/bin/env python3
"""
Human Flourishing Frameworks - Main Flask Application

Research software for AI bias monitoring. Violation data shown is synthetic
unless explicitly labeled with a real citation. See data_sources.py for
details on mock vs. real datasets.
"""

from flask import Flask, jsonify, render_template_string, request
import hmac
import math
import os
from datetime import datetime, timezone
import uuid
import threading

from adoption_tracker import (
    init_adoption_db, register_node, get_adoption_stats,
    get_nodes_list, get_active_nodes, get_total_nodes, start_heartbeat,
    get_verified_node_count
)
from mesh_network import (
    init_mesh_db, get_mesh_violations, receive_mesh_sync, sync_with_mesh
)
from data_sources import get_compas_summary
from seed_data import ALL_SEED_MEASUREMENTS
from agent_system import (
    AutonomousAgentSystem,
    AITraderAgent,
    ViolationDetectionAgent,
    CryptographicVerificationAgent,
    ByzantineConsensusAgent,
    AutonomousEscalationAgent,
    ImmutableAuditAgent,
    SystemHealthAgent,
    NetworkDiscoveryAgent,
    IMMUTABLE_RULES,
)
from cryptographic_proof import generate_keypair, load_keypair, save_keypair
from sensors import Measurement, SensorRegistry
from world_model import WorldModel, Intervention
from live_sensors import create_live_sensors, run_observation_loop
from chat_memory_integration import ChatMemoryIntegration

app = Flask(__name__)

# Register Dream Journal blueprint
try:
    from routes.dream_journal import dream_bp
    app.register_blueprint(dream_bp)
    print("[OK] Dream Journal API routes registered")
except Exception as e:
    print(f"[WARNING] Could not register Dream Journal routes: {e}")

# Initialize chat memory integration
try:
    chat_memory = ChatMemoryIntegration()
    print("[OK] Chat memory integration initialized")
except Exception as e:
    print(f"[WARNING] Could not initialize chat memory: {e}")
    chat_memory = None

MIN_CONSENSUS_NODES = int(os.environ.get('MIN_CONSENSUS_NODES', '3'))
WRITE_TOKEN = os.environ.get('HFF_WRITE_TOKEN', '')
ADOPTION_ACCEPT_TOKEN = os.environ.get('HFF_ADOPTION_ACCEPT_TOKEN', '')
ALLOW_PUBLIC_WRITES = os.environ.get('HFF_ALLOW_PUBLIC_WRITES', '').lower() in {
    '1', 'true', 'yes', 'on'
}
ENABLE_MESH_SYNC = os.environ.get('ENABLE_MESH_SYNC', '').lower() in {
    '1', 'true', 'yes', 'on'
}
ENABLE_LIVE_SENSORS = os.environ.get('ENABLE_LIVE_SENSORS', '').lower() in {
    '1', 'true', 'yes', 'on'
}
ENABLE_AI_TRADER = os.environ.get('ENABLE_AI_TRADER', '').lower() in {
    '1', 'true', 'yes', 'on'
}
def _request_bearer_or_header(header_name):
    supplied = request.headers.get(header_name, '')
    auth = request.headers.get('Authorization', '')
    if auth.lower().startswith('bearer '):
        supplied = auth[7:].strip()
    return supplied


def require_adoption_grant(action):
    """Return an error response unless adoption telemetry has an explicit grant."""
    if ALLOW_PUBLIC_WRITES:
        return None

    supplied = _request_bearer_or_header('X-HFF-Adoption-Token')

    if ADOPTION_ACCEPT_TOKEN and supplied and hmac.compare_digest(
        supplied, ADOPTION_ACCEPT_TOKEN
    ):
        return None

    if WRITE_TOKEN and supplied and hmac.compare_digest(supplied, WRITE_TOKEN):
        return None

    return jsonify({
        "error": "adoption_grant_required",
        "action": action,
        "message": (
            "This endpoint registers node liveness telemetry. Production "
            "adoption writes require HFF_ADOPTION_ACCEPT_TOKEN, HFF_WRITE_TOKEN "
            "operator fallback, or an explicit HFF_ALLOW_PUBLIC_WRITES=true "
            "demo override."
        ),
    }), 403
def require_write_grant(action):
    """Return an error response unless this write has an explicit grant."""
    if ALLOW_PUBLIC_WRITES:
        return None

    supplied = _request_bearer_or_header('X-HFF-Write-Token')

    if WRITE_TOKEN and supplied and hmac.compare_digest(supplied, WRITE_TOKEN):
        return None

    return jsonify({
        "error": "write_grant_required",
        "action": action,
        "message": (
            "This endpoint changes local state. Production writes require "
            "HFF_WRITE_TOKEN or an explicit HFF_ALLOW_PUBLIC_WRITES=true "
            "demo override."
        ),
    }), 403

# ---------------------------------------------------------------------------
# Database init (safe to call multiple times)
# ---------------------------------------------------------------------------
try:
    init_adoption_db()
except Exception:
    pass

try:
    init_mesh_db()
except Exception:
    pass

# ---------------------------------------------------------------------------
# Node identity
# ---------------------------------------------------------------------------
NODE_ID = str(uuid.uuid4())
NODE_NAME = os.environ.get('NODE_NAME', f'node-{NODE_ID[:8]}')
PLATFORM = os.environ.get('PLATFORM', 'web')
REGION = os.environ.get('NODE_REGION', '')
OPERATOR_TYPE = os.environ.get('OPERATOR_TYPE', '')
DEPLOYMENT_TYPE = os.environ.get('DEPLOYMENT_TYPE', '')
NODE_PUBLIC_KEY = os.environ.get('NODE_PUBLIC_KEY', '')
_adoption_bootstrap_started = False


def bootstrap_adoption_heartbeat(log=False):
    """Register this WSGI process as a visible adoption node once."""
    global _adoption_bootstrap_started
    if _adoption_bootstrap_started:
        return False

    try:
        register_node(NODE_ID, NODE_NAME, PLATFORM, region=REGION,
                      operator_type=OPERATOR_TYPE,
                      deployment_type=DEPLOYMENT_TYPE,
                      node_public_key=NODE_PUBLIC_KEY)
        if log:
            print(f"\n[OK] Node registered: {NODE_NAME} ({PLATFORM})")

        start_heartbeat(NODE_ID, NODE_NAME, PLATFORM, interval=60,
                        region=REGION, operator_type=OPERATOR_TYPE,
                        deployment_type=DEPLOYMENT_TYPE,
                        node_public_key=NODE_PUBLIC_KEY)
        if log:
            print("[OK] Heartbeat started - syncing every 60 seconds")

        _adoption_bootstrap_started = True
        return True
    except Exception as e:
        if log:
            print(f"\n[WARNING] Could not register node: {e}")
        return False

# ---------------------------------------------------------------------------
# Background threads â€” only heartbeat + mesh sync (no propagation)
# ---------------------------------------------------------------------------
if ENABLE_MESH_SYNC:
    mesh_sync_thread = threading.Thread(target=sync_with_mesh, daemon=True)
    mesh_sync_thread.start()

# ---------------------------------------------------------------------------
# Autonomous agent system â€” node keypair + initialization
# ---------------------------------------------------------------------------
_NODE_KEY_DIR = os.path.join(os.path.dirname(__file__), "data")
_NODE_KEY_PRIV = os.path.join(_NODE_KEY_DIR, "node_key.pem")
_NODE_KEY_PUB = os.path.join(_NODE_KEY_DIR, "node_key_pub.pem")

try:
    _node_private, _node_public = load_keypair(_NODE_KEY_PRIV, _NODE_KEY_PUB)
except Exception:
    _node_private, _node_public = generate_keypair()
    try:
        save_keypair(_node_private, _node_public, _NODE_KEY_PRIV, _NODE_KEY_PUB)
    except Exception:
        pass  # keys stay in memory only

if not NODE_PUBLIC_KEY:
    try:
        NODE_PUBLIC_KEY = _node_public.decode() if isinstance(_node_public, bytes) else str(_node_public)
    except Exception:
        NODE_PUBLIC_KEY = ''

_PEER_URLS = [
    u.strip() for u in os.environ.get("PEER_URLS", "").split(",") if u.strip()
]

autonomous_system = AutonomousAgentSystem(
    private_key=_node_private,
    public_key=_node_public,
    peer_urls=_PEER_URLS,
    node_id=NODE_ID,
)

# Initialize AI Trader Agent if enabled
if ENABLE_AI_TRADER:
    try:
        # Attempt to find a suitable Python interpreter
        python_bin = os.environ.get('PYTHON_BIN')
        if not python_bin:
            import shutil
            python_bin = shutil.which('python3') or shutil.which('python')
            if not python_bin:
                raise RuntimeError("No Python interpreter found. Set PYTHON_BIN environment variable.")

        ai_trader_agent = AITraderAgent(python_bin=python_bin)
        autonomous_system.add_agent(ai_trader_agent)
        print(f"[OK] AI Trader Agent initialized and added to autonomous system using interpreter: {python_bin}")
    except Exception as e:
        print(f"[ERROR] Failed to initialize AI Trader Agent: {e}")
else:
    print("[INFO] AI Trader Agent is disabled. Set ENABLE_AI_TRADER=true to enable.")

# ---------------------------------------------------------------------------
# World model â€” Bayesian belief tracking + sensor framework
# ---------------------------------------------------------------------------
_world_sensor_registry = SensorRegistry()
world_model = WorldModel(
    sensors=_world_sensor_registry,
    db_path=os.path.join(os.path.dirname(__file__), "data", "world_model.db"),
)

# ---------------------------------------------------------------------------
# Bootstrap â€” seed the world model with REAL data only
# ---------------------------------------------------------------------------
# The world model starts empty. Without initial observations it has no beliefs
# and nothing to show. This bootstrap feeds published, cited, real-world
# findings into the sensorâ†’world_model pipeline so the system has something
# true to reason about from the moment it starts.
#
# NO mock data enters the world model. Mock violations stay in the demo UI
# where they are clearly labeled synthetic.
# ---------------------------------------------------------------------------


def _bootstrap_world_model() -> None:
    """Seed the world model with observations from peer-reviewed research.

    Draws from seed_data.py which contains measurements from 30+ published
    sources covering humans (health, autonomy, fairness, opportunity),
    animals (health, safety, comfort, natural_behavior), and ecosystems
    (biodiversity, stability, resilience).

    Every measurement comes from peer-reviewed or publicly audited research.
    No mock data enters the world model. Each carries honest uncertainty.
    See seed_data.py for full source citations and methodology notes.
    """
    # Skip if the model already has beliefs (persistence across restarts)
    if world_model.beliefs:
        return

    bootstrap_measurements = ALL_SEED_MEASUREMENTS

    updates = world_model.update(bootstrap_measurements)
    print(f"[BOOTSTRAP] Seeded {len(updates)} beliefs from real published data")
    for u in updates:
        print(
            f"  - {u['entity']}: posterior={u['posterior']:.3f}, "
            f"uncertainty={u['uncertainty']:.3f}"
        )


_bootstrap_world_model()

# ---------------------------------------------------------------------------
# Live sensors â€” poll real public APIs on a background thread
# ---------------------------------------------------------------------------
# Register live sensors (World Bank, WHO) that continuously observe the world.
# The observation loop runs every hour (data sources update at most daily).
# On startup, sensors fire immediately so the model gets live data fast.
# ---------------------------------------------------------------------------

_live_sensors = []
if ENABLE_LIVE_SENSORS:
    _live_sensors = create_live_sensors()
    for _sensor in _live_sensors:
        _world_sensor_registry.register(_sensor)
    print(f"[SENSORS] Registered {len(_live_sensors)} live sensors")

# Background observation thread â€” polls APIs and feeds world_model.update()
    _observation_thread = threading.Thread(
        target=run_observation_loop,
        args=(_world_sensor_registry, world_model),
        kwargs={"interval_seconds": 3600},  # 1 hour between cycles
        daemon=True,
    )
    _observation_thread.start()
    print("[SENSORS] Background observation loop started (1-hour cycle)")
else:
    print("[SENSORS] Live sensors disabled; set ENABLE_LIVE_SENSORS=true to enable")

# ---------------------------------------------------------------------------
# HTML template
# ---------------------------------------------------------------------------
HTML_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Human Flourishing Frameworks</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            color: #e0e0e0;
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        header {
            text-align: center;
            margin-bottom: 40px;
            padding: 40px 20px;
            background: rgba(26, 31, 74, 0.8);
            border-radius: 12px;
            border: 1px solid rgba(0, 255, 136, 0.3);
        }
        h1 { font-size: 36px; margin-bottom: 10px; color: #00ffff; }
        h2 { margin: 40px 0 20px 0; }
        h3 { margin-bottom: 10px; }
        .subtitle { color: #888; font-size: 16px; }
        .status-badge {
            display: inline-block;
            background: rgba(0, 255, 136, 0.2);
            border: 1px solid #00ff88;
            color: #00ff88;
            padding: 8px 16px;
            border-radius: 20px;
            margin-top: 15px;
            font-size: 12px;
            font-weight: bold;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin: 20px 0;
        }
        .stat-box {
            background: rgba(26, 31, 74, 0.8);
            border: 1px solid rgba(0, 255, 136, 0.3);
            border-radius: 12px;
            padding: 20px;
            text-align: center;
        }
        .stat-number { font-size: 32px; color: #00ffff; font-weight: bold; }
        .stat-label { color: #888; font-size: 12px; margin-top: 8px; }
        .section-banner {
            border-radius: 8px;
            padding: 16px 20px;
            margin: 20px 0;
            font-size: 14px;
        }
        .banner-green { background: rgba(0, 255, 136, 0.1); border: 1px solid #00ff88; color: #00ff88; }
        .banner-orange { background: rgba(255, 136, 0, 0.1); border: 1px solid #ff8800; color: #ff8800; }
        .banner-yellow { background: rgba(255, 200, 0, 0.15); border: 1px solid #ffcc00; color: #ffcc00; }

        /* Belief cards */
        .belief-group { margin: 20px 0; }
        .belief-group-title {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .belief-card {
            background: rgba(26, 31, 74, 0.6);
            border-radius: 8px;
            padding: 14px 18px;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 16px;
        }
        .belief-bar-wrap {
            flex: 1;
            min-width: 0;
        }
        .belief-name {
            font-size: 13px;
            color: #ccc;
            margin-bottom: 4px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .belief-bar-bg {
            height: 22px;
            background: rgba(255,255,255,0.08);
            border-radius: 4px;
            position: relative;
            overflow: hidden;
        }
        .belief-bar-fill {
            height: 100%;
            border-radius: 4px;
            transition: width 0.5s ease;
        }
        .belief-bar-ci {
            position: absolute;
            top: 0;
            height: 100%;
            border-left: 2px solid rgba(255,255,255,0.3);
            border-right: 2px solid rgba(255,255,255,0.3);
            background: rgba(255,255,255,0.05);
        }
        .belief-value {
            font-size: 14px;
            font-weight: bold;
            min-width: 50px;
            text-align: right;
        }
        .belief-unc {
            font-size: 11px;
            color: #888;
            min-width: 60px;
            text-align: right;
        }
        .belief-source {
            font-size: 10px;
            color: #666;
            margin-top: 2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .belief-source a { color: #4488cc; text-decoration: none; }
        .belief-source a:hover { text-decoration: underline; }

        /* Sensor feed */
        .sensor-card {
            background: rgba(26, 31, 74, 0.6);
            border-left: 3px solid #00ff88;
            border-radius: 8px;
            padding: 12px 16px;
            margin-bottom: 8px;
        }
        .sensor-card.degraded { border-left-color: #ff8800; }
        .sensor-card .sensor-name { font-size: 14px; color: #00ffff; font-weight: bold; }
        .sensor-card .sensor-meta { font-size: 11px; color: #888; margin-top: 4px; }

        /* Flourishing gauges */
        .flourishing-card {
            background: rgba(26, 31, 74, 0.8);
            border: 1px solid rgba(0, 255, 136, 0.3);
            border-radius: 12px;
            padding: 24px;
            text-align: center;
        }
        .flourishing-score { font-size: 42px; font-weight: bold; color: #00ff88; }
        .flourishing-scope { font-size: 16px; color: #ccc; margin-top: 4px; text-transform: capitalize; }
        .flourishing-unc { font-size: 12px; color: #888; margin-top: 4px; }
        .flourishing-bar {
            height: 8px;
            background: rgba(255,255,255,0.1);
            border-radius: 4px;
            margin-top: 12px;
            overflow: hidden;
        }
        .flourishing-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #ff4444, #ffcc00, #00ff88);
            border-radius: 4px;
            transition: width 0.5s ease;
        }

        /* Discovery cards */
        .discovery-card {
            background: rgba(26, 31, 74, 0.6);
            border-left: 3px solid #00ff88;
            border-radius: 8px;
            padding: 14px 18px;
            margin-bottom: 8px;
        }
        .discovery-card .disc-type { font-size: 13px; font-weight: bold; }
        .discovery-card .disc-desc { font-size: 13px; color: #bbb; margin-top: 4px; }

        /* Agents grid */
        .agent-box {
            background: rgba(26, 31, 74, 0.8);
            border: 1px solid rgba(255, 136, 0, 0.4);
            border-radius: 12px;
            padding: 16px;
            text-align: center;
        }
        .agent-name { font-size: 14px; color: #ff8800; font-weight: bold; }
        .agent-desc { font-size: 11px; color: #888; margin-top: 4px; }
        .agent-status { font-size: 11px; color: #00ff88; margin-top: 6px; }

        /* Violations */
        .violation-card {
            background: rgba(26, 31, 74, 0.6);
            border-left: 4px solid #ff4444;
            border-radius: 8px;
            padding: 16px 20px;
            margin-bottom: 10px;
        }
        .violation-card h3 { color: #00ffff; font-size: 15px; }
        .violation-card p { color: #bbb; font-size: 13px; margin-top: 4px; }
        .sev-badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: bold;
            color: white;
            margin-top: 6px;
        }
        .sev-critical { background: #ff4444; }
        .sev-high { background: #ff8800; }
        .sev-medium { background: #ffcc00; color: #333; }
        .sev-low { background: #44bb44; }

        footer {
            text-align: center;
            margin-top: 60px;
            padding-top: 20px;
            border-top: 1px solid rgba(0, 255, 136, 0.2);
            color: #666;
            font-size: 12px;
        }
        .collapsible-header {
            cursor: pointer;
            user-select: none;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .collapsible-header .arrow { transition: transform 0.2s; }
        .collapsible-header.collapsed .arrow { transform: rotate(-90deg); }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Human Flourishing Frameworks</h1>
            <p class="subtitle">Observe outcomes. Model causes. Optimize for flourishing.</p>
            <div class="status-badge" id="status-badge">
                STATUS &mdash; <span id="wm-belief-count-header">0</span> beliefs
                &mdash; <span id="wm-sensor-count-header">0</span> registered sensors
                &mdash; <span id="wm-domains-header">0</span> domains
            </div>
        </header>

        <!-- ============================================================ -->
        <!-- FLOURISHING SCORES â€” the headline -->
        <!-- ============================================================ -->
        <h2 style="color: #00ff88;">What the Model Knows</h2>
        <div class="section-banner banner-green">
            Every score carries uncertainty. A score of 56% &plusmn; 16% means
            flourishing could plausibly be 40%&ndash;72%. The model updates
            these as new verified or best-effort observations arrive.
        </div>
        <div class="stats" id="flourishing-grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
            <!-- populated by JS -->
        </div>

        <!-- ============================================================ -->
        <!-- BELIEFS â€” grouped by scope, with bars -->
        <!-- ============================================================ -->
        <h2 style="color: #00ff88;">All Beliefs</h2>
        <div class="section-banner banner-green">
            Each bar shows the model's posterior probability (0&ndash;1) for that
            measurement. The faded region is the confidence interval. Every belief
            traces to a published source.
        </div>
        <div id="beliefs-container">
            <p style="color: #888;">Loading beliefs...</p>
        </div>

        <!-- ============================================================ -->
        <!-- LIVE SENSORS -->
        <!-- ============================================================ -->
        <h2 style="color: #00ff88;">Sensor Registry</h2>
        <div class="section-banner banner-green">
            Sensors are registered first and only update the model when live
            sensors are explicitly enabled. Registry presence is not proof of
            live observation; see the public health endpoint for runtime state.
        </div>
        <div id="sensors-container">
            <p style="color: #888;">Loading sensors...</p>
        </div>

        <!-- ============================================================ -->
        <!-- DISCOVERED PATTERNS -->
        <!-- ============================================================ -->
        <h2 style="color: #00ffff;">Discovered Patterns</h2>
        <div id="discoveries-container">
            <p style="color: #888;">Loading discoveries...</p>
        </div>

        <!-- ============================================================ -->
        <!-- ADVISORY AGENT STATUS (collapsed by default) -->
        <!-- ============================================================ -->
        <h2 style="color: #ff8800;">
            <span class="collapsible-header" onclick="toggleSection('governance-section', this)">
                <span class="arrow">&#9660;</span> Advisory Agent Status
                <span style="font-size: 13px; font-weight: normal; color: #888;">
                    &mdash; <span id="agent-count">7</span> agents,
                    <span id="audit-entries">0</span> audit entries
                </span>
            </span>
        </h2>
        <div id="governance-section">
            <div class="section-banner banner-orange">
                <strong>EXPERIMENTAL ADVISORY AGENTS</strong> &mdash; Research/demo agents expose advisory workflow status and audit records. They are not a human board, regulator, court, enforcement system, or autonomous authority. Escalations are review records only unless explicitly authorized by an operator.
            </div>
            <div class="stats" id="agents-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
            </div>
        </div>

        <footer>
            <p>Human Flourishing Frameworks &mdash; Research Software</p>
            <p style="margin-top: 8px;">
                The model is always incomplete somewhere. Corrections are logged for review.
            </p>
        </footer>
    </div>

    <script>
        function toggleSection(id, header) {
            const el = document.getElementById(id);
            if (el.style.display === 'none') {
                el.style.display = '';
                header.classList.remove('collapsed');
            } else {
                el.style.display = 'none';
                header.classList.add('collapsed');
            }
        }

        // Color for a posterior value
        function posteriorColor(v) {
            if (v > 0.7) return '#00ff88';
            if (v > 0.4) return '#00ffff';
            if (v > 0.2) return '#ffcc00';
            return '#ff4444';
        }

        // Readable name from entity key
        function readableName(entity) {
            // e.g. "humans:health:doi:10.1037/..." -> last meaningful segment
            const parts = entity.split(':');
            // find the part that looks like a topic, not a URL
            let name = parts.slice(0, 2).join(' > ');
            if (parts.length > 2) {
                let source = parts.slice(2).join(':');
                // shorten DOIs and URLs
                if (source.startsWith('doi:')) source = source.substring(0, 30) + '...';
                if (source.startsWith('http')) {
                    try { source = new URL(source).hostname; } catch(e) {}
                }
                name += '  [' + source + ']';
            }
            return name;
        }

        function shortSource(src) {
            if (!src || src === 'unknown') return '';
            if (src.startsWith('http')) {
                try { return new URL(src).hostname; } catch(e) { return src.substring(0, 40); }
            }
            if (src.startsWith('doi:')) return src.substring(0, 40);
            return src.substring(0, 50);
        }

        // Visible degraded-state fallback for failed safe-read fetches.
        // Replaces silent catches so the public dashboard fails honestly.
        function showDashboardDegraded(sectionId) {
            const el = document.getElementById(sectionId);
            if (!el) return;
            el.innerHTML = '<div class="section-banner banner-yellow">Some dashboard data is temporarily unavailable. This page is advisory research software; verify deployment health with the public health endpoint before relying on current status.</div>';
        }

        // ---- WORLD MODEL STATUS ----
        fetch('/api/world/status')
            .then(r => r.json())
            .then(data => {
                document.getElementById('wm-belief-count-header').textContent = data.belief_count || 0;
                document.getElementById('wm-sensor-count-header').textContent = data.sensor_count || 0;
                document.getElementById('wm-domains-header').textContent = (data.domains || []).length;

                // Flourishing scores
                const scores = data.flourishing_scores || {};
                const grid = document.getElementById('flourishing-grid');
                grid.innerHTML = '';

                // order: humans, animals, ecosystems, then rest
                const order = ['humans', 'animals', 'ecosystems'];
                const sortedScopes = Object.keys(scores).sort((a, b) => {
                    const ai = order.indexOf(a), bi = order.indexOf(b);
                    if (ai >= 0 && bi >= 0) return ai - bi;
                    if (ai >= 0) return -1;
                    if (bi >= 0) return 1;
                    return a.localeCompare(b);
                });

                sortedScopes.forEach(scope => {
                    const s = scores[scope];
                    const pct = (s.score * 100).toFixed(0);
                    const unc = (s.uncertainty * 100).toFixed(0);
                    const card = document.createElement('div');
                    card.className = 'flourishing-card';
                    card.innerHTML = `
                        <div class="flourishing-score">${pct}%</div>
                        <div class="flourishing-scope">${scope}</div>
                        <div class="flourishing-unc">&plusmn;${unc}% uncertainty</div>
                        <div class="flourishing-bar">
                            <div class="flourishing-bar-fill" style="width: ${pct}%"></div>
                        </div>
                    `;
                    grid.appendChild(card);
                });

                // Summary stats row
                const summaryHtml = `
                    <div class="stat-box" style="border-color: rgba(0,255,136,0.3);">
                        <div class="stat-number" style="color: #00ff88;">${data.belief_count || 0}</div>
                        <div class="stat-label">Beliefs Tracked</div>
                    </div>
                    <div class="stat-box" style="border-color: rgba(0,255,136,0.3);">
                        <div class="stat-number" style="color: #00ff88;">${data.sensor_count || 0}</div>
                        <div class="stat-label">Registered Sensors</div>
                    </div>
                    <div class="stat-box" style="border-color: rgba(0,255,136,0.3);">
                        <div class="stat-number" style="color: #00ff88;">${
                            data.average_uncertainty !== undefined
                                ? (data.average_uncertainty * 100).toFixed(0) + '%' : '--'
                        }</div>
                        <div class="stat-label">Avg Uncertainty</div>
                    </div>
                    <div class="stat-box" style="border-color: rgba(0,255,136,0.3);">
                        <div class="stat-number" style="color: #00ff88;">${data.corrections_count || 0}</div>
                        <div class="stat-label">Self-Corrections</div>
                    </div>
                    <div class="stat-box" style="border-color: rgba(0,255,136,0.3);">
                        <div class="stat-number" style="color: #00ff88;">${(data.domains||[]).length}</div>
                        <div class="stat-label">Domains</div>
                    </div>
                    <div class="stat-box" style="border-color: rgba(0,255,136,0.3);">
                        <div class="stat-number" style="color: #00ff88;">${(data.scopes||[]).length}</div>
                        <div class="stat-label">Scopes</div>
                    </div>
                `;
                const summaryRow = document.createElement('div');
                summaryRow.className = 'stats';
                summaryRow.innerHTML = summaryHtml;
                grid.parentNode.insertBefore(summaryRow, grid.nextSibling);
            })
            .catch(() => showDashboardDegraded('flourishing-grid'));

        // ---- ALL BELIEFS ----
        fetch('/api/world/beliefs?per_page=200')
            .then(r => r.json())
            .then(data => {
                const beliefs = data.beliefs || [];
                const container = document.getElementById('beliefs-container');
                container.innerHTML = '';

                // Group by scope prefix (humans, animals, ecosystems, universe)
                const groups = {};
                beliefs.forEach(b => {
                    const scopeRoot = b.scope.split(':')[0];
                    if (!groups[scopeRoot]) groups[scopeRoot] = [];
                    groups[scopeRoot].push(b);
                });

                // Sort groups
                const groupOrder = ['humans', 'animals', 'ecosystems', 'universe'];
                const sortedGroups = Object.keys(groups).sort((a, b) => {
                    const ai = groupOrder.indexOf(a), bi = groupOrder.indexOf(b);
                    if (ai >= 0 && bi >= 0) return ai - bi;
                    if (ai >= 0) return -1;
                    if (bi >= 0) return 1;
                    return a.localeCompare(b);
                });

                sortedGroups.forEach(groupName => {
                    const groupBeliefs = groups[groupName];
                    // Sort by scope then posterior descending
                    groupBeliefs.sort((a, b) => {
                        if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
                        return b.posterior - a.posterior;
                    });

                    const groupDiv = document.createElement('div');
                    groupDiv.className = 'belief-group';

                    const colors = {
                        humans: '#00ffff',
                        animals: '#ff8800',
                        ecosystems: '#00ff88',
                        universe: '#aa88ff'
                    };
                    const color = colors[groupName] || '#ccc';

                    groupDiv.innerHTML = `<div class="belief-group-title" style="color: ${color};">
                        ${groupName.charAt(0).toUpperCase() + groupName.slice(1)}
                        <span style="font-size: 13px; color: #888; font-weight: normal;">
                            (${groupBeliefs.length} beliefs)
                        </span>
                    </div>`;

                    groupBeliefs.forEach(b => {
                        const pct = (b.posterior * 100).toFixed(0);
                        const uncPct = (b.uncertainty * 100).toFixed(0);
                        const barColor = posteriorColor(b.posterior);

                        // Confidence interval bar
                        const ciLo = b.evidence && b.evidence.length > 0
                            ? (b.evidence[b.evidence.length-1].confidence_interval || [0,0])[0]
                            : 0;
                        const ciHi = b.evidence && b.evidence.length > 0
                            ? (b.evidence[b.evidence.length-1].confidence_interval || [0,0])[1]
                            : 0;

                        // Nice label from entity
                        const parts = b.entity.split(':');
                        let label = parts.slice(0, 2).join(' : ');
                        let sourceLabel = '';
                        if (parts.length > 2) {
                            let src = parts.slice(2).join(':');
                            if (src.startsWith('http')) {
                                try {
                                    const u = new URL(src);
                                    sourceLabel = u.hostname;
                                } catch(e) { sourceLabel = src.substring(0, 50); }
                            } else if (src.startsWith('doi:')) {
                                sourceLabel = src.substring(0, 40) + (src.length > 40 ? '...' : '');
                            } else {
                                sourceLabel = src.substring(0, 50);
                            }
                        }

                        const card = document.createElement('div');
                        card.className = 'belief-card';
                        card.innerHTML = `
                            <div class="belief-bar-wrap">
                                <div class="belief-name" title="${b.entity}">
                                    ${label}${sourceLabel ? ' <span style="color:#666">['+sourceLabel+']</span>' : ''}
                                </div>
                                <div class="belief-bar-bg">
                                    <div class="belief-bar-fill" style="width: ${pct}%; background: ${barColor};"></div>
                                    ${ciLo > 0 || ciHi > 0 ? `<div class="belief-bar-ci" style="left: ${ciLo*100}%; width: ${(ciHi-ciLo)*100}%;"></div>` : ''}
                                </div>
                                <div class="belief-source">
                                    ${b.domain} &middot; ${b.scope} &middot; updated ${b.last_updated ? new Date(b.last_updated).toLocaleDateString() : 'unknown'}
                                </div>
                            </div>
                            <div class="belief-value" style="color: ${barColor};">${pct}%</div>
                            <div class="belief-unc">&plusmn;${uncPct}%</div>
                        `;
                        groupDiv.appendChild(card);
                    });

                    container.appendChild(groupDiv);
                });
            })
            .catch(() => showDashboardDegraded('beliefs-container'));

        // ---- LIVE SENSORS ----
        fetch('/api/world/status')
            .then(r => r.json())
            .then(statusData => {
                // Sensor health comes from the registry
                return fetch('/api/world/status');
            })
            .catch(() => showDashboardDegraded('sensors-container'));

        // Use a dedicated endpoint or embed sensor health in status
        // For now, we'll show what we know from the world status
        fetch('/api/world/beliefs?per_page=200')
            .then(r => r.json())
            .then(data => {
                const beliefs = data.beliefs || [];
                const container = document.getElementById('sensors-container');
                container.innerHTML = '';

                // Extract unique live sensor sources
                const liveSensors = new Map();
                beliefs.forEach(b => {
                    if (b.evidence) {
                        b.evidence.forEach(e => {
                            const src = e.source || '';
                            if (src.includes('worldbank') || src.includes('who.int')) {
                                const method = e.methodology || '';
                                // Parse sensor name from methodology
                                let sensorName = 'Unknown Sensor';
                                let rawVal = '';
                                const parts = method.split(':');
                                if (parts.length >= 2) {
                                    sensorName = parts[0] === 'world_bank_api'
                                        ? 'World Bank: ' + parts[1]
                                        : parts[0] === 'who_gho_api'
                                        ? 'WHO GHO: ' + parts[1]
                                        : parts[0] + ': ' + parts[1];
                                }
                                if (method.includes('raw=')) {
                                    rawVal = method.split('raw=')[1].split(':')[0];
                                }
                                const key = sensorName;
                                if (!liveSensors.has(key)) {
                                    liveSensors.set(key, {
                                        name: sensorName,
                                        source: src,
                                        scope: b.scope,
                                        raw: rawVal,
                                        temporal: e.temporal_range || ['?', '?'],
                                        uncertainty: e.uncertainty,
                                    });
                                }
                            }
                        });
                    }
                });

                if (liveSensors.size === 0) {
                    // Show sensor definitions even before first observation
                    container.innerHTML = '<p style="color: #888;">9 sensors registered. Waiting for first observation cycle...</p>';
                    return;
                }

                liveSensors.forEach((s, key) => {
                    const card = document.createElement('div');
                    card.className = 'sensor-card';
                    card.innerHTML = `
                        <div class="sensor-name">${s.name}</div>
                        <div class="sensor-meta">
                            Scope: <strong>${s.scope}</strong>
                            &middot; Raw value: <strong>${s.raw || '?'}</strong>
                            &middot; Data year: <strong>${s.temporal[1] || '?'}</strong>
                            &middot; Uncertainty: <strong>${s.uncertainty ? (s.uncertainty*100).toFixed(0)+'%' : '?'}</strong>
                            &middot; <a href="${s.source}" target="_blank" style="color: #4488cc;">${shortSource(s.source)}</a>
                        </div>
                    `;
                    container.appendChild(card);
                });
            })
            .catch(() => showDashboardDegraded('sensors-container'));

        // ---- DISCOVERIES ----
        fetch('/api/world/discover')
            .then(r => r.json())
            .then(data => {
                const discoveries = data.discoveries || [];
                const container = document.getElementById('discoveries-container');
                if (discoveries.length === 0) {
                    container.innerHTML = '<p style="color: #888;">No patterns discovered yet.</p>';
                    return;
                }
                container.innerHTML = '';
                discoveries.forEach(d => {
                    const color = d.severity === 'actionable' ? '#ffcc00'
                                : d.severity === 'interesting' ? '#00ffff' : '#888';
                    const card = document.createElement('div');
                    card.className = 'discovery-card';
                    card.style.borderLeftColor = color;
                    card.innerHTML = `
                        <div class="disc-type" style="color: ${color};">${d.type}</div>
                        <div class="disc-desc">${d.description}</div>
                    `;
                    container.appendChild(card);
                });
            })
            .catch(() => showDashboardDegraded('discoveries-container'));

        // ---- ADVISORY AGENT STATUS ----
        fetch('/api/autonomous/status')
            .then(r => r.json())
            .then(data => {
                const agents = data.agents || [];
                document.getElementById('agent-count').textContent = agents.length;

                const audit = data.audit_chain || {};
                document.getElementById('audit-entries').textContent = audit.entries_checked || 0;

                const grid = document.getElementById('agents-grid');
                grid.innerHTML = '';
                agents.forEach(a => {
                    const box = document.createElement('div');
                    box.className = 'agent-box';
                    box.innerHTML = `
                        <div class="agent-name">${a.agent}</div>
                        <div class="agent-desc">${a.description || ''}</div>
                        <div class="agent-status">${a.status || 'active'}</div>
                    `;
                    grid.appendChild(box);
                });
            })
            .catch(() => showDashboardDegraded('agents-grid'));

        // Register this browser as a node
        fetch('/api/adoption/register', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                node_id: '{{ node_id }}',
                node_name: '{{ node_name }}',
                platform: '{{ platform }}',
                region: '{{ region }}',
                operator_type: '{{ operator_type }}',
                deployment_type: '{{ deployment_type }}',
                node_public_key: '{{ node_public_key }}'
            })
        }).catch(() => {});
    </script>
</body>
</html>
"""

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    """Main dashboard â€” renders the HTML template with node identity."""
    return render_template_string(
        HTML_TEMPLATE,
        node_id=NODE_ID,
        node_name=NODE_NAME,
        platform=PLATFORM,
        region=REGION,
        operator_type=OPERATOR_TYPE,
        deployment_type=DEPLOYMENT_TYPE,
        node_public_key=NODE_PUBLIC_KEY,
    )


@app.route('/health')
def health():
    """Health check (e.g. for Heroku)."""
    return jsonify({"status": "ok"}), 200


@app.route('/healthz')
def healthz():
    """Lightweight readiness probe with explicit toggle visibility.

    Reports the runtime state of the public-write/sensor/mesh toggles so
    deployment platforms and operators can see capability state without
    reading dashboard copy.
    """
    return jsonify({
        "status": "ok",
        "service": "human-flourishing-frameworks",
        "live_sensors_enabled": ENABLE_LIVE_SENSORS,
        "mesh_sync_enabled": ENABLE_MESH_SYNC,
        "public_writes_enabled": ALLOW_PUBLIC_WRITES,
    }), 200


@app.route('/api/status')
def api_status():
    """Honest system status â€” no fabricated numbers."""
    try:
        adoption = get_adoption_stats()
    except Exception:
        adoption = {}
    return jsonify({
        "status": "running",
        "timestamp": datetime.utcnow().isoformat(),
        "mode": "research",
        "data_source": "mock",
        "node_id": NODE_ID,
        "verified_nodes": adoption.get("verified_nodes", 0),
        "security_nodes": adoption.get("security_node_count", 0),
        "min_consensus_nodes": MIN_CONSENSUS_NODES,
        "write_policy": {
            "public_writes_enabled": ALLOW_PUBLIC_WRITES,
            "write_token_configured": bool(WRITE_TOKEN),
            "protected_endpoints": [
                "/api/adoption/register",
                "/api/autonomous/submit",
                "/api/world/observe",
            ],
        },
        "outbound_sync": {
            "adoption_sync_enabled": os.environ.get('ENABLE_ADOPTION_SYNC', '').lower() in {
                '1', 'true', 'yes', 'on'
            },
            "mesh_sync_enabled": ENABLE_MESH_SYNC,
            "live_sensors_enabled": ENABLE_LIVE_SENSORS,
        },
        "disclaimer": (
            "This is research software. Violation data shown is synthetic "
            "unless labeled otherwise."
        ),
    })


@app.route('/api/violations/compas')
def api_compas():
    """Return a summary of the real ProPublica COMPAS analysis."""
    return jsonify(get_compas_summary())


# ---------------------------------------------------------------------------
# Adoption tracker endpoints (real, honest code)
# ---------------------------------------------------------------------------

@app.route('/api/adoption/register', methods=['POST'])
def adoption_register():
    """Register a new node."""
    grant_error = require_adoption_grant("adoption_register")
    if grant_error:
        return grant_error

    try:
        data = request.json
        register_node(
            data.get('node_id', str(uuid.uuid4())),
            data.get('node_name', 'unknown'),
            data.get('platform', 'web'),
            data.get('version', '1.0.0'),
            data.get('region', ''),
            data.get('operator_type', ''),
            data.get('deployment_type', ''),
            data.get('node_public_key', ''),
        )
        return jsonify({"status": "registered"}), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/adoption/stats')
def adoption_stats():
    """Get adoption statistics from the local database."""
    try:
        stats = get_adoption_stats()
        return jsonify(stats), 200
    except Exception as e:
        return jsonify({
            "total_nodes": 0,
            "active_last_hour": 0,
            "active_last_24h": 0,
            "last_7_days": 0,
            "by_platform": {},
            "error": str(e),
        }), 200


@app.route('/api/adoption/nodes')
def adoption_nodes():
    """Get list of recent nodes."""
    try:
        limit = request.args.get('limit', 50, type=int)
        nodes = get_nodes_list(limit)
        return jsonify(nodes), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/adoption/dashboard')
def adoption_dashboard():
    """Get adoption dashboard data."""
    try:
        stats = get_adoption_stats()
        return jsonify({
            "stats": stats,
            "this_node": {
                "id": NODE_ID,
                "name": NODE_NAME,
                "platform": PLATFORM,
                "region": REGION,
                "operator_type": OPERATOR_TYPE,
                "deployment_type": DEPLOYMENT_TYPE,
                "node_public_key": NODE_PUBLIC_KEY,
                "verified": False,
            },
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Mesh network endpoints (honest HTTP sync)
# ---------------------------------------------------------------------------

@app.route('/api/mesh/violations')
def mesh_violations():
    """Get violations synced from the mesh network."""
    try:
        violations = get_mesh_violations()
        return jsonify({
            "violations": violations,
            "count": len(violations),
            "timestamp": datetime.utcnow().isoformat(),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 200


@app.route('/api/mesh/sync', methods=['POST'])
def mesh_sync():
    """Receive mesh sync payloads only when mesh sync is explicitly enabled."""
    if not ENABLE_MESH_SYNC:
        return jsonify({
            "error": "mesh_sync_disabled",
            "message": "Set ENABLE_MESH_SYNC=true to allow mesh sync writes.",
        }), 403

    try:
        payload = request.get_json(silent=True)
        if not payload:
            return jsonify({"error": "JSON body required"}), 400
        return jsonify(receive_mesh_sync(payload)), 200
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Autonomous agent system endpoints
# ---------------------------------------------------------------------------


@app.route('/api/autonomous/submit', methods=['POST'])
def autonomous_submit():
    """Submit violation evidence for autonomous processing.

    Runs the full pipeline: Detect -> Verify -> Consensus -> Lock -> Escalate.
    Evidence must include 'accuracy_gap' (float), 'system_name' (str),
    and 'description' (str).
    """
    grant_error = require_write_grant("autonomous_submit")
    if grant_error:
        return grant_error

    try:
        evidence = request.json
        if not evidence:
            return jsonify({"error": "JSON body required"}), 400
        result = autonomous_system.submit_evidence(evidence)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/autonomous/status')
def autonomous_status():
    """Current autonomous system status: agents, rules, escalation queue."""
    try:
        status = autonomous_system.get_status()
        return jsonify(status), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/autonomous/escalations')
def autonomous_escalations():
    """List locked, pending, and executed escalations."""
    try:
        limit = request.args.get('limit', 50, type=int)
        escalations = autonomous_system.autonomous_escalation.get_all_escalations(limit)
        pending = autonomous_system.autonomous_escalation.check_pending()
        return jsonify({
            "escalations": escalations,
            "pending_execution": pending,
            "total": len(escalations),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/autonomous/audit')
def autonomous_audit():
    """Audit trail entries from the immutable log."""
    try:
        limit = request.args.get('limit', 100, type=int)
        entries = autonomous_system.immutable_audit.get_entries(limit)
        chain = autonomous_system.immutable_audit.verify_chain()
        return jsonify({
            "entries": entries,
            "chain_valid": chain["chain_valid"],
            "entries_checked": chain["entries_checked"],
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/autonomous/rules')
def autonomous_rules():
    """Return the public projection of declared rules.

    Internal-only flags whose names imply governance authority the software
    does not possess (e.g., ``no_human_override``, ``escalation_is_irreversible``)
    are omitted from this public payload; see
    ``agent_system.public_immutable_rules_view`` for the projection logic.
    """
    try:
        return jsonify(autonomous_system.get_rules()), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# World model endpoints
# ---------------------------------------------------------------------------


@app.route('/api/world/status')
def world_status():
    """World model status: belief count, sensor count, last update, flourishing.

    The model is always wrong somewhere. The 'average_uncertainty' field
    tells you roughly how wrong -- higher means more ignorant. This is
    honest self-assessment, not false modesty.
    """
    try:
        status = world_model.status()
        return jsonify(status), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/world/beliefs')
def world_beliefs():
    """Current beliefs, paginated and filterable by domain/scope.

    Each belief includes its uncertainty -- the most important number
    after the posterior itself. A posterior of 0.8 with uncertainty 0.6
    is NOT a confident belief.

    Query params:
        domain: filter by domain (e.g., 'healthcare')
        scope: filter by scope (e.g., 'humans')
        page: page number (default 1)
        per_page: items per page (default 50, max 200)
    """
    try:
        domain = request.args.get('domain')
        scope = request.args.get('scope')
        page = request.args.get('page', 1, type=int)
        per_page = min(request.args.get('per_page', 50, type=int), 200)

        all_beliefs = list(world_model.beliefs.values())

        if domain:
            all_beliefs = [b for b in all_beliefs if b.domain == domain]
        if scope:
            all_beliefs = [b for b in all_beliefs if b.scope == scope]

        # Sort by last_updated descending
        all_beliefs.sort(key=lambda b: b.last_updated, reverse=True)

        total = len(all_beliefs)
        start = (page - 1) * per_page
        end = start + per_page
        page_beliefs = all_beliefs[start:end]

        return jsonify({
            "beliefs": [b.to_dict() for b in page_beliefs],
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": math.ceil(total / per_page) if total > 0 else 0,
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/world/belief/<path:entity>')
def world_belief_detail(entity):
    """Detailed belief for one entity, including full history.

    The history shows how the model's belief has evolved over time.
    Large swings in the posterior indicate either contradictory evidence
    or a genuinely volatile phenomenon. Steady convergence indicates
    the model is learning something stable.
    """
    try:
        belief = world_model.query(entity)
        if belief is None:
            return jsonify({
                "error": "not_found",
                "entity": entity,
                "message": (
                    "no belief exists for this entity. the model has not "
                    "observed it yet. this does not mean it does not exist "
                    "-- only that no sensor has measured it."
                ),
            }), 404

        history = world_model.get_history(entity)

        return jsonify({
            "belief": belief.to_dict(),
            "history": history,
            "evidence_count": len(belief.evidence),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/world/observe', methods=['POST'])
def world_observe():
    """Submit new sensor measurements for Bayesian update.

    Accepts a list of measurements. Each measurement must include at
    minimum: value, uncertainty, confidence_interval, source, and scope.

    The model updates its beliefs based on these measurements. More
    certain measurements (lower uncertainty) shift beliefs more.

    Request body:
    {
        "measurements": [
            {
                "value": 0.73,
                "uncertainty": 0.15,
                "confidence_interval": [0.65, 0.81],
                "source": "hospital_xyz_records",
                "scope": "healthcare:hospital_xyz",
                "methodology": "administrative_records",
                "sample_size": 500,
                "confounders": ["income_not_controlled"],
                "missing": ["rural_patients_excluded"]
            }
        ]
    }
    """
    grant_error = require_write_grant("world_observe")
    if grant_error:
        return grant_error

    try:
        data = request.json
        if not data or "measurements" not in data:
            return jsonify({
                "error": "request must include 'measurements' array",
            }), 400

        raw_measurements = data["measurements"]
        if not isinstance(raw_measurements, list):
            return jsonify({"error": "'measurements' must be an array"}), 400

        measurements = []
        errors = []
        for i, raw in enumerate(raw_measurements):
            try:
                m = Measurement.from_dict(raw)
                measurements.append(m)
            except Exception as e:
                errors.append({"index": i, "error": str(e)})

        if not measurements:
            return jsonify({
                "error": "no valid measurements in request",
                "parse_errors": errors,
            }), 400

        updates = world_model.update(measurements)

        return jsonify({
            "updates": updates,
            "measurements_processed": len(measurements),
            "parse_errors": errors,
            "disclaimer": (
                "beliefs have been updated. the model is now slightly less "
                "wrong than before (probably). check uncertainty values."
            ),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/world/predict/<path:entity>')
def world_predict(entity):
    """What interventions could improve this entity's flourishing?

    Returns a list of hypothetical interventions with predicted effects.
    Every prediction includes uncertainty bounds and caveats. These are
    suggestions based on current beliefs, not prescriptions.

    Query params:
        action: specific action to evaluate (default: 'improve')
    """
    try:
        action = request.args.get('action', 'improve')
        interventions = world_model.counterfactual(entity, action)

        predictions = []
        for intervention in interventions:
            prediction = world_model.predict(intervention)
            predictions.append(prediction.to_dict())

        return jsonify({
            "entity": entity,
            "predictions": predictions,
            "disclaimer": (
                "these are speculative predictions, not guarantees. "
                "correlation does not imply causation. second-order "
                "effects are especially uncertain."
            ),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/world/flourishing')
def world_flourishing():
    """Aggregate flourishing scores by scope.

    Returns flourishing scores for all scopes the model knows about.
    Each score includes uncertainty -- a score of 70% with 40% uncertainty
    means flourishing could plausibly be anywhere from 30% to 100%.

    Query params:
        scope: specific scope to query (returns all if not specified)
    """
    try:
        specific_scope = request.args.get('scope')

        if specific_scope:
            score = world_model.flourishing_score(specific_scope)
            metric = world_model.get_flourishing_metric(specific_scope)
            return jsonify({
                "scope": specific_scope,
                "score": score.to_dict(),
                "components": metric.to_dict()["components"],
                "disclaimer": (
                    "flourishing is a value-laden concept. these components "
                    "and weights reflect choices, not objective truths."
                ),
            }), 200

        # All scopes
        scopes = list(set(
            b.scope for b in world_model.beliefs.values()
        ))
        # Also include explicitly configured flourishing metrics
        scopes = list(set(
            scopes + list(world_model._flourishing_metrics.keys())
        ))

        results = {}
        for scope in scopes:
            try:
                score = world_model.flourishing_score(scope)
                results[scope] = score.to_dict()
            except Exception:
                pass

        return jsonify({
            "flourishing_by_scope": results,
            "scopes_measured": len(results),
            "disclaimer": (
                "flourishing metrics are approximations. unmeasured dimensions "
                "(joy, meaning, beauty) are invisible to this model."
            ),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/world/corrections')
def world_corrections():
    """Every time the model self-corrected.

    A correction happens when new evidence significantly shifts a belief
    (more than 5% change in posterior). Frequent corrections mean the
    model is learning. No corrections could mean the model is stagnant
    or not receiving new data.

    Query params:
        limit: max corrections to return (default 100)
    """
    try:
        limit = request.args.get('limit', 100, type=int)
        corrections = world_model.correction_log[:limit]

        return jsonify({
            "corrections": corrections,
            "total": len(world_model.correction_log),
            "returned": len(corrections),
            "disclaimer": (
                "corrections are a feature, not a bug. a model that never "
                "corrects itself is not learning."
            ),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/world/discover')
def world_discover():
    """Anomalies and discovered patterns in current beliefs.

    The model looks for:
    - Outlier beliefs (posteriors far from priors with low uncertainty)
    - Measurement gaps (clusters of high-uncertainty beliefs)
    - Stale beliefs (not updated recently)
    - Correlated beliefs (entities moving together, suggesting shared causes)

    These are hypotheses to investigate, not conclusions.
    """
    try:
        discoveries = world_model.discover()
        return jsonify({
            "discoveries": discoveries,
            "count": len(discoveries),
            "disclaimer": (
                "patterns found here are exploratory, not causal. "
                "the model finds correlations, not causes."
            ),
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Chat Memory Integration Routes
# ---------------------------------------------------------------------------

@app.route('/api/chat/log', methods=['POST'])
def chat_log_message():
    """
    Log a chat message to the cryptographic audit chain and memory system.

    Request body:
    {
        "user_id": "user123",
        "message": "Hello, how are you?",
        "role": "user",
        "metadata": {
            "lucidity": 0.8,
            "emotional_intensity": 0.5
        }
    }
    """
    if not chat_memory:
        return jsonify({"error": "chat memory not initialized"}), 503

    try:
        data = request.json
        if not data or "message" not in data:
            return jsonify({"error": "request must include 'message'"}), 400

        user_id = data.get("user_id", "anonymous")
        message = data.get("message", "")
        role = data.get("role", "user")
        metadata = data.get("metadata", {})

        result = chat_memory.log_chat_message(user_id, message, role, metadata)
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/chat/verify', methods=['GET'])
def chat_verify_integrity():
    """
    Verify the integrity of the entire conversation chain.

    Returns verification status, entry count, coherence score, etc.
    """
    if not chat_memory:
        return jsonify({"error": "chat memory not initialized"}), 503

    try:
        result = chat_memory.verify_conversation_integrity()
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/chat/fallacy-check', methods=['POST'])
def chat_check_fallacies():
    """
    Check a message for logical fallacies using Bayesian detection.

    Request body:
    {
        "message": "Either you're with us or against us."
    }

    Returns detected fallacies with probabilities and explanations.
    """
    if not chat_memory:
        return jsonify({"error": "chat memory not initialized"}), 503

    try:
        data = request.json
        if not data or "message" not in data:
            return jsonify({"error": "request must include 'message'"}), 400

        message = data.get("message", "")
        fallacies = chat_memory.fallacy_detector.detect_fallacies(message)
        hint = chat_memory.get_fallacy_hint(message)

        return jsonify({
            "message": message,
            "fallacies": fallacies,
            "hint": hint,
            "has_fallacies": len(fallacies) > 0
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/chat/memory-summary', methods=['GET'])
def chat_memory_summary():
    """
    Get a summary of the memory system state.

    Returns memory statistics, audit chain stats, and identity information.
    """
    if not chat_memory:
        return jsonify({"error": "chat memory not initialized"}), 503

    try:
        result = chat_memory.get_memory_summary()
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/chat/anti-entropy-audit', methods=['POST'])
def chat_anti_entropy_audit():
    """
    Run a comprehensive anti-entropy audit of the memory system.

    Returns audit results and any detected inconsistencies.
    """
    if not chat_memory:
        return jsonify({"error": "chat memory not initialized"}), 503

    try:
        result = chat_memory.anti_entropy_audit()
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/chat/public-key', methods=['GET'])
def chat_get_public_key():
    """
    Get the current public key for the audit chain.

    Returns the Ed25519 public key in hex format.
    """
    if not chat_memory:
        return jsonify({"error": "chat memory not initialized"}), 503

    try:
        public_key = chat_memory.get_public_key()
        return jsonify({
            "public_key": public_key,
            "algorithm": "Ed25519",
            "timestamp": datetime.now(timezone.utc).isoformat()
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/chat/rotate-key', methods=['POST'])
def chat_rotate_key():
    """
    Rotate the cryptographic key for the audit chain.

    This invalidates the old key and creates a new signing key.
    All future entries will be signed with the new key.
    """
    if not chat_memory:
        return jsonify({"error": "chat memory not initialized"}), 503

    grant_error = require_write_grant("chat_key_rotation")
    if grant_error:
        return grant_error

    try:
        result = chat_memory.rotate_audit_key()
        return jsonify(result), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    # Register this node on startup
    try:
        register_node(NODE_ID, NODE_NAME, PLATFORM, region=REGION,
                      operator_type=OPERATOR_TYPE,
                      deployment_type=DEPLOYMENT_TYPE,
                      node_public_key=NODE_PUBLIC_KEY)
        print(f"\n[OK] Node registered: {NODE_NAME} ({PLATFORM})")

        # Start heartbeat (keeps node visible in adoption tracker)
        start_heartbeat(NODE_ID, NODE_NAME, PLATFORM, interval=60,
                        region=REGION, operator_type=OPERATOR_TYPE,
                        deployment_type=DEPLOYMENT_TYPE,
                        node_public_key=NODE_PUBLIC_KEY)
        print("[OK] Heartbeat started â€” syncing every 60 seconds")
    except Exception as e:
        print(f"\n[WARNING] Could not register node: {e}")

    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)




