// Σ₀ execution verifier — the execVerdict PRODUCER for council-review.js.
//
// "Correctness costs an external check." This runs a proposed code change against a test in a
// bounded subprocess and returns {ran, passed, output} — the ground-truth signal councilReview
// folds as the dominant anchor (passed → grounded, failed → refuted/retry). It is the external
// terminal condition that reopens the seam (src/cio_sde/question.py): a real test, not the
// model's own judgment, decides correctness. It is the precondition for long-horizon
// self-correction — the loop runs this, and a `refuted` verdict carries the failure output back
// as the grounding for the next attempt.
//
// Shell-free (execFileSync shell:false, per the lib/safe-exec philosophy) + hard timeout +
// temp-dir isolation. It runs the MODEL's proposed code (not untrusted operator input); the
// caller decides whether execution is appropriate for the surface, and the timeout bounds it.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// One file, run by its interpreter. The `test` is appended after the `code` and is expected to
// THROW / exit non-zero on failure (the HumanEval/run_test contract) — exit 0 == passed.
const RUNNERS = {
  js: { cmd: "node", ext: ".js" },
  python: { cmd: "python", ext: ".py" },
};

const MAX_OUTPUT = 2000; // cap the failure text we hand back as the self-correction signal

/**
 * Run `code` + `test` in a bounded subprocess.
 *
 * @param {object} opts
 * @param {string} [opts.language="js"]  js | python
 * @param {string} [opts.code]           the proposed implementation
 * @param {string} [opts.test]           a check that throws / exits non-zero on failure
 * @param {number} [opts.timeoutMs=10000]
 * @returns {{ran:boolean, passed:boolean, output:string}}
 *   ran=false  → could not execute (unsupported language, runner missing) — NOT a refutation
 *   passed     → exit 0; failed → non-zero exit / timeout, with `output` = the failure text
 */
function verifyExec(opts = {}) {
  const { language = "js", code = "", test = "", timeoutMs = 10000 } = opts;
  const runner = RUNNERS[language];
  if (!runner) return { ran: false, passed: false, output: `unsupported language: ${language}` };

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sigma0-exec-"));
  } catch (e) {
    return { ran: false, passed: false, output: `tempdir failed: ${e.message}` };
  }
  const file = path.join(dir, "case" + runner.ext);
  try {
    fs.writeFileSync(file, `${code}\n${test}\n`, "utf8");
    try {
      const out = execFileSync(runner.cmd, [file], {
        timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8", windowsHide: true,
        cwd: dir,                  // run in the isolated temp dir, not the server's working dir
        maxBuffer: 512 * 1024,     // cap runaway output (and make the overflow path explicit, not a fake "timeout")
        // SECURITY: do NOT inherit the server env — it holds API keys (ANTHROPIC/OPENAI/DISCORD…).
        // Model-proposed code must not be able to read or exfiltrate them. Pass a minimal env;
        // PATH + SystemRoot are what node/python need to launch on Windows + POSIX.
        env: { PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", TMP: dir, TEMP: dir },
      });
      return { ran: true, passed: true, output: String(out).slice(0, MAX_OUTPUT) };
    } catch (e) {
      // ENOENT = the interpreter isn't installed → we could not RUN (not a refutation).
      if (e.code === "ENOENT") {
        return { ran: false, passed: false, output: `runner not found: ${runner.cmd}` };
      }
      // Non-zero exit (the test threw), timeout, or output overflow → ran, but did NOT pass. A
      // hanging or runaway solution is treated as failing so the loop retries instead of stalling.
      // Overflow is distinguished from timeout so the failure fed back is accurate ("print less",
      // not "run faster").
      const overflow = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      const timedOut = !overflow && (e.killed || e.signal === "SIGTERM" || /ETIMEDOUT/.test(String(e.code)));
      const text = String(e.stderr || "") + String(e.stdout || "") || e.message || "";
      const prefix = overflow ? "output-limit-exceeded\n" : timedOut ? "timeout\n" : "";
      return { ran: true, passed: false, output: prefix + text.slice(0, MAX_OUTPUT) };
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

module.exports = { verifyExec, RUNNERS };
