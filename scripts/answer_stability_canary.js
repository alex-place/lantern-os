#!/usr/bin/env node
"use strict";

/**
 * Answer-stability canary runner (#2859) — cron-ready determinism check.
 *
 *   node scripts/answer_stability_canary.js
 *
 * Reads the canonical set from data/ledger/canary-questions.json, compares
 * against the LAST run in the append-only data/ledger/stability-canary.jsonl,
 * appends this run, prints the verdict, and exits 1 on any alarm
 * (answer moved without an evidence delta, or coverage lost).
 */

const fs = require("fs");
const path = require("path");

const { runCanary } = require("../lib/answer-stability-canary");

const ROOT = path.resolve(__dirname, "..");
const QUESTIONS_FILE = path.join(ROOT, "data", "ledger", "canary-questions.json");
const STATE_FILE = path.join(ROOT, "data", "ledger", "stability-canary.jsonl");

function lastRun(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* torn tail line → keep walking back */
    }
  }
  return null;
}

function main() {
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8")).questions;
  const prior = lastRun(STATE_FILE);
  const run = runCanary({ questions, priorRows: prior ? prior.rows : null });

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.appendFileSync(STATE_FILE, JSON.stringify(run) + "\n");

  console.log(`answer-stability canary — ${run.ts}`);
  for (const r of run.rows) console.log(`  ${r.status.padEnd(16)} ${r.question}`);
  console.log(`stability ${run.stable}/${run.comparable} comparable = ${run.stability.toFixed(3)} · alarms ${run.alarms.length}`);
  if (run.alarms.length) {
    console.error("DRIFT ALARM — answers moved without an evidence delta (or lost coverage):");
    for (const a of run.alarms) console.error(`  ${a.status}: ${a.question}`);
    process.exit(1);
  }
}

main();
