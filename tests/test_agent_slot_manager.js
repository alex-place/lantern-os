/**
 * Tests for Agent Slot Manager
 * Verifies agent slot lifecycle and health monitoring
 */

const AgentSlotManager = require("../src/agent-slot-manager");

async function runTests() {
  let passed = 0;
  let failed = 0;

  const asm = new AgentSlotManager(require("path").join(process.env.HOME || process.env.USERPROFILE, ".claude", "agent-slots.json"));

  // Test 1: Load configuration
  try {
    const slots = asm.getEnabledSlots();
    if (slots.length > 0) {
      console.log("✓ Test 1: Load configuration — PASS");
      passed++;
    } else {
      throw new Error("No enabled slots loaded");
    }
  } catch (e) {
    console.log(`✗ Test 1: Load configuration — FAIL: ${e.message}`);
    failed++;
  }

  // Test 2: Get idle slot
  try {
    const idle = asm.getIdleSlot();
    if (idle && idle.status === "idle") {
      console.log("✓ Test 2: Get idle slot — PASS");
      passed++;
    } else {
      throw new Error("No idle slot returned");
    }
  } catch (e) {
    console.log(`✗ Test 2: Get idle slot — FAIL: ${e.message}`);
    failed++;
  }

  // Test 3: Assign work
  try {
    const slot = asm.getSlot("claude-1");
    const work = { id: "issue-335", issueNumber: 335 };
    const assigned = asm.assignWork("claude-1", work);

    if (assigned.status === "working" && assigned.currentWork?.id === "issue-335") {
      console.log("✓ Test 3: Assign work — PASS");
      passed++;
    } else {
      throw new Error("Work not assigned correctly");
    }
  } catch (e) {
    console.log(`✗ Test 3: Assign work — FAIL: ${e.message}`);
    failed++;
  }

  // Test 4: Complete work
  try {
    const result = asm.completeWork("claude-1", {
      workId: "issue-335",
      duration: 300,
    });

    const slot = asm.getSlot("claude-1");
    if (slot.status === "idle" && slot.completedCount === 1) {
      console.log("✓ Test 4: Complete work — PASS");
      passed++;
    } else {
      throw new Error("Work completion not recorded");
    }
  } catch (e) {
    console.log(`✗ Test 4: Complete work — FAIL: ${e.message}`);
    failed++;
  }

  // Test 5: Heartbeat
  try {
    const idle = asm.getIdleSlot();
    if (idle) {
      const status = asm.heartbeat(idle.id);
      if (status === "idle") {
        console.log("✓ Test 5: Heartbeat — PASS");
        passed++;
      } else {
        throw new Error("Heartbeat failed");
      }
    } else {
      throw new Error("No idle slot");
    }
  } catch (e) {
    console.log(`✗ Test 5: Heartbeat — FAIL: ${e.message}`);
    failed++;
  }

  // Test 6: Health check
  try {
    const health = asm.checkHealth();
    if (Array.isArray(health) && health.length > 0) {
      console.log("✓ Test 6: Health check — PASS");
      passed++;
    } else {
      throw new Error("Health check failed");
    }
  } catch (e) {
    console.log(`✗ Test 6: Health check — FAIL: ${e.message}`);
    failed++;
  }

  // Test 7: Get stats
  try {
    const stats = asm.getStats();
    if (stats.totalSlots > 0 && typeof stats.successRate === "number") {
      console.log("✓ Test 7: Get stats — PASS");
      passed++;
    } else {
      throw new Error("Stats not computed correctly");
    }
  } catch (e) {
    console.log(`✗ Test 7: Get stats — FAIL: ${e.message}`);
    failed++;
  }

  // Summary
  console.log(`\n[Agent Slot Manager Tests] Passed: ${passed}/7, Failed: ${failed}/7`);
  return failed === 0;
}

if (require.main === module) {
  runTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Test error:", err);
      process.exit(1);
    });
}

module.exports = { runTests };
