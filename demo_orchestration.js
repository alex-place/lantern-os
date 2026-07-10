#!/usr/bin/env node

/**
 * Agent Orchestration System Demo
 * Shows Queue + Slot Manager working together
 */

const QueueManager = require("./src/queue-manager");
const AgentSlotManager = require("./src/agent-slot-manager");
const path = require("path");

async function demo() {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("   AGENT ORCHESTRATION SYSTEM — LIVE DEMO");
  console.log("═══════════════════════════════════════════════════════\n");

  // Initialize managers
  const queuePath = path.join(__dirname, "data", "demo-queue");
  const qm = new QueueManager(queuePath);
  const sm = new AgentSlotManager();

  // Step 1: Add work to queue
  console.log("📋 STEP 1: Add GitHub issues to work queue");
  console.log("────────────────────────────────────────────");

  const issues = [
    { issueNumber: 335, title: "Phase 2: Stage Routing", priority: 5 },
    { issueNumber: 336, title: "Phase 3: Door Generation", priority: 3 },
    { issueNumber: 337, title: "Phase 4: Scene Images", priority: 2 },
  ];

  for (const issue of issues) {
    const work = await qm.enqueueWork({
      issueNumber: issue.issueNumber,
      title: issue.title,
      priority: issue.priority,
    });
    console.log(`  ✓ #${work.issueNumber} → pending queue`);
  }

  // Step 2: Check queue status
  console.log("\n📊 STEP 2: Queue status");
  console.log("────────────────────────────────────────────");

  let status = await qm.getStatus();
  console.log(`  Pending: ${status.pending} items`);
  console.log(`  Assigned: ${status.assigned} items`);
  console.log(`  Completed: ${status.completed} items`);

  // Step 3: Assign work to agents
  console.log("\n🤖 STEP 3: Agent lanes claim work");
  console.log("────────────────────────────────────────────");

  const agents = ["claude", "gemini", "codex"];
  const assignments = [];

  for (const agent of agents) {
    const work = await qm.getNextWork(agent);
    if (work) {
      const slot = sm.assignWork(agent, work);
      assignments.push({ agent, work });
      console.log(`  ${agent} lane → assigned #${work.issueNumber} (${work.title})`);
    }
  }

  // Step 4: Check agent status
  console.log("\n📊 STEP 4: Agent status after assignment");
  console.log("────────────────────────────────────────────");

  const health = sm.checkHealth();
  for (const h of health) {
    const status = h.status === "working" ? "🔴" : "🟢";
    const work = h.currentWork ? ` (issue #${h.currentWork})` : "";
    console.log(`  ${status} ${h.slot}${work}`);
  }

  // Step 5: Simulate work completion
  console.log("\n✅ STEP 5: Agents complete work");
  console.log("────────────────────────────────────────────");

  for (const { agent, work } of assignments.slice(0, 2)) {
    const completed = await qm.markComplete(work.id, {
      pr: `PR #${100 + parseInt(work.issueNumber)}`,
      branch: `${agent}/issue-${work.issueNumber}`,
    });
    sm.completeWork(agent, { workId: work.id, duration: 1234 });
    console.log(`  ✓ ${agent} completed #${work.issueNumber}`);
  }

  // Step 6: Simulate failure and retry
  console.log("\n❌ STEP 6: Agent encounters error (will retry)");
  console.log("────────────────────────────────────────────");

  if (assignments.length > 2) {
    const { agent, work } = assignments[2];
    await qm.markFailed(work.id, "Network timeout");
    sm.failWork(agent, "Network timeout");
    console.log(`  ! ${agent} failed #${work.issueNumber} (retry 1/3)`);
  }

  // Step 7: Final status
  console.log("\n📈 STEP 7: Final orchestration status");
  console.log("────────────────────────────────────────────");

  status = await qm.getStatus();
  const stats = sm.getStats();

  console.log(`  Queue:`);
  console.log(`    Pending: ${status.pending}`);
  console.log(`    In Progress: ${status.assigned}`);
  console.log(`    Completed: ${status.completed}`);
  console.log(`    Failed: ${status.failed}`);

  console.log(`\n  Agent Statistics:`);
  console.log(`    Total Lanes: ${stats.totalSlots}`);
  console.log(`    Enabled: ${stats.enabledSlots}`);
  console.log(`    Success Rate: ${(stats.successRate * 100).toFixed(1)}%`);
  console.log(`    Completed Work: ${stats.totalCompleted}`);

  // Step 8: Show dream-chat response format
  console.log("\n💬 STEP 8: Dream-chat agent report");
  console.log("────────────────────────────────────────────");

  const pendingItems = await qm.listByStatus("pending");
  const completedItems = await qm.listByStatus("completed");

  console.log(`\n  When user asks: "What work is being done?"\n`);
  console.log(`  Keystone responds:\n`);
  console.log(`  Claude lane: Ready for work`);
  console.log(`  Gemini lane: Idle`);
  console.log(`  Codex lane: Idle`);
  console.log(`  \n  Queue Status:`);
  console.log(`  • ${pendingItems.length} issues waiting`);
  console.log(`  • ${completedItems.length} completed this session`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("   ✅ AGENT ORCHESTRATION SYSTEM OPERATIONAL");
  console.log("═══════════════════════════════════════════════════════\n");
}

demo().catch((err) => {
  console.error("Demo error:", err);
  process.exit(1);
});
