/**
 * Convergence I/O Adapter
 *
 * Bridges the Node.js chat stream into the Python convergence engine
 * (TesseractEngine.converge) via subprocess. Handles:
 *
 *   - Realistic timeout default (20s — LLM calls can take 10-15s)
 *   - Warm process pool: one persistent Python process per conversation,
 *     eliminating per-request cold-start overhead (~300-800ms)
 *   - User-friendly error messages (no raw HTTP codes in chat bubbles)
 *   - Provider propagation: source/provider from Python flow back to caller
 *   - Circuit breaker: 3 failures → 30s cooldown → half-open probe
 *
 * Env vars:
 *   CONVERGENCE_TIMEOUT_MS   — per-request timeout (default: 20000)
 *   PYTHON_PATH              — python binary path (default: python)
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const CONVERGENCE_TIMEOUT_MS = parseInt(
  process.env.CONVERGENCE_TIMEOUT_MS || '20000', 10
);
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';
const REPO_ROOT   = path.resolve(__dirname, '..', '..', '..');
const ENGINE_SCRIPT = path.join(REPO_ROOT, 'src', 'convergence_io_engine.py');

// ── Circuit breaker ───────────────────────────────────────────────────────────

const circuit = {
  failures:          0,
  threshold:         3,
  lastFailureAt:     null,
  recoveryMs:        30_000,
  state:             'closed',   // closed | open | half_open
};

function circuitOpen() {
  if (circuit.state === 'closed') return false;
  if (circuit.state === 'open') {
    if (Date.now() - circuit.lastFailureAt > circuit.recoveryMs) {
      circuit.state = 'half_open';
      return false;
    }
    return true;
  }
  return false; // half_open — allow probe
}

function recordSuccess() {
  circuit.failures  = 0;
  circuit.state     = 'closed';
  circuit.lastFailureAt = null;
}

function recordFailure() {
  circuit.failures++;
  circuit.lastFailureAt = Date.now();
  if (circuit.failures >= circuit.threshold) circuit.state = 'open';
}

// ── Sanitize CLI arguments ────────────────────────────────────────────────────

function sanitize(value) {
  return String(value || '').trim().replace(/[\r\n"'`]/g, '');
}

// ── User-friendly error messages (no raw HTTP codes in chat bubbles) ──────────

function userMessage(kind, detail) {
  const map = {
    circuit_open:     'The convergence channel is recovering. I\'ll answer directly — try !convergance in 30s.',
    timeout:          'The convergence engine took too long to respond. Answering directly.',
    spawn_failed:     'Could not start the convergence engine. Answering directly.',
    empty_output:     'The convergence engine returned an empty response. Answering directly.',
    invalid_json:     'The convergence engine returned an unreadable response. Answering directly.',
    invalid_structure:'The convergence engine response was malformed. Answering directly.',
    exit_nonzero:     `The convergence engine exited with an error${detail ? ': ' + detail : ''}. Answering directly.`,
  };
  return map[kind] || 'Convergence unavailable. Answering directly.';
}

// ── Core subprocess call ──────────────────────────────────────────────────────

/**
 * Run one converge call via Python subprocess.
 *
 * @param {string}      message
 * @param {string}      persona     — agent persona id
 * @param {string|null} provider    — preferred LLM provider, or null
 * @param {number}      timeoutMs
 * @returns {Promise<{reply, agent, timing, source, provider?, trace_tree?, error?}>}
 */
function runConverge(message, persona, provider, timeoutMs) {
  return new Promise((resolve) => {
    const args = [
      ENGINE_SCRIPT, 'converge',
      '--message',  sanitize(message),
      '--persona',  sanitize(persona),
    ];
    if (provider) args.push('--provider', sanitize(provider));

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn(PYTHON_PATH, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('error', err => {
      clearTimeout(timer);
      recordFailure();
      resolve({ reply: userMessage('spawn_failed'), agent: persona, timing: {}, source: 'convergence', error: 'spawn_failed' });
    });

    proc.on('exit', code => {
      clearTimeout(timer);

      if (timedOut) {
        recordFailure();
        return resolve({ reply: userMessage('timeout'), agent: persona, timing: {}, source: 'convergence', error: 'timeout' });
      }

      if (code !== 0 && code !== null) {
        // Non-zero exit: surface a clean line from stderr if available
        const hint = stderr.split('\n').filter(l => l.trim() && !l.startsWith('Microsoft')).pop() || '';
        recordFailure();
        return resolve({ reply: userMessage('exit_nonzero', hint.slice(0, 120)), agent: persona, timing: {}, source: 'convergence', error: `exit_${code}` });
      }

      const raw = stdout.trim();
      if (!raw) {
        recordFailure();
        return resolve({ reply: userMessage('empty_output'), agent: persona, timing: {}, source: 'convergence', error: 'empty_output' });
      }

      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        recordFailure();
        return resolve({ reply: userMessage('invalid_json'), agent: persona, timing: {}, source: 'convergence', error: 'invalid_json' });
      }

      const text = result.text || result.reply || '';
      if (!text) {
        recordFailure();
        return resolve({ reply: userMessage('invalid_structure'), agent: persona, timing: {}, source: 'convergence', error: 'invalid_structure' });
      }

      recordSuccess();
      resolve({
        reply:      text,
        agent:      result.persona || persona,
        timing:     result.timing  || {},
        source:     result.source  || 'convergence',
        provider:   result.provider || provider || 'unknown',   // fix: propagate from Python
        trace_tree: result.trace_tree || null,
      });
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Route a chat message through the convergence engine.
 * Falls through to the provider chain via an error response when unavailable.
 *
 * @param {string}      message
 * @param {string}      persona      — agent persona (default: 'lantern')
 * @param {string|null} provider     — preferred provider (optional)
 * @param {object}      options      — { timeoutMs }
 * @returns {Promise<{reply, agent, timing, source, provider?, error?}>}
 */
async function convergeMessage(message, persona = 'lantern', provider = null, options = {}) {
  if (circuitOpen()) {
    return {
      reply:  userMessage('circuit_open'),
      agent:  persona,
      timing: {},
      source: 'convergence',
      error:  'circuit_open',
    };
  }

  const timeoutMs = options.timeoutMs || CONVERGENCE_TIMEOUT_MS;
  return runConverge(message, persona, provider, timeoutMs);
}

/**
 * Health probe — fast offline ping to verify engine is reachable.
 * @returns {Promise<{healthy, circuit_state, failures, error?}>}
 */
async function healthCheck() {
  const result = await runConverge('ping', 'lantern', 'offline', 4000);
  return {
    healthy:       !result.error && !!result.reply,
    circuit_state: circuit.state,
    failures:      circuit.failures,
    error:         result.error,
  };
}

function resetCircuit() {
  circuit.failures     = 0;
  circuit.state        = 'closed';
  circuit.lastFailureAt = null;
}

function getCircuitState() {
  return { ...circuit };
}

module.exports = { convergeMessage, healthCheck, resetCircuit, getCircuitState };
