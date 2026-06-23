"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { appendJsonlQueued } = require("./file-queue");

const GOALS_PATH = path.resolve(__dirname, "..", "..", "..", "data", "goals.jsonl");

const SCHEDULE_MS = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
  once: null,
};

function nextRunAt(schedule, from = new Date()) {
  const ms = SCHEDULE_MS[schedule];
  if (ms == null) return from.toISOString();
  return new Date(from.getTime() + ms).toISOString();
}

function createGoal(title, description, schedule, subTaskPrompts = []) {
  if (!SCHEDULE_MS.hasOwnProperty(schedule)) {
    throw new Error(`Unknown schedule "${schedule}". Must be one of: ${Object.keys(SCHEDULE_MS).join(", ")}`);
  }
  const now = new Date();
  const goal = {
    id: `goal:${crypto.randomUUID()}`,
    title,
    description,
    horizon: schedule === "once" ? "once" : "recurring",
    schedule,
    status: "active",
    createdAt: now.toISOString(),
    lastRunAt: null,
    nextRunAt: nextRunAt(schedule, now),
    subTasks: subTaskPrompts.map((prompt) => ({
      id: `st:${crypto.randomUUID()}`,
      prompt,
      status: "pending",
      result: null,
      ranAt: null,
    })),
    completedRuns: 0,
  };
  appendJsonlQueued(GOALS_PATH, goal);
  return goal;
}

// Last-write-wins by id so a goals.jsonl snapshot reflects the latest state per goal.
function listGoals() {
  let raw;
  try {
    raw = fs.readFileSync(GOALS_PATH, "utf8");
  } catch {
    return [];
  }
  const latest = new Map();
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (record && record.id) latest.set(record.id, record);
    } catch {
      // skip malformed lines
    }
  }
  return Array.from(latest.values());
}

function getGoalsDue() {
  const now = new Date();
  return listGoals().filter(
    (g) => g.status === "active" && g.nextRunAt && new Date(g.nextRunAt) <= now
  );
}

function markGoalRan(goalId, results = []) {
  const goals = listGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return null;

  const now = new Date();
  const updated = {
    ...goal,
    lastRunAt: now.toISOString(),
    completedRuns: (goal.completedRuns || 0) + 1,
    nextRunAt: goal.schedule === "once" ? goal.nextRunAt : nextRunAt(goal.schedule, now),
    status: goal.schedule === "once" ? "completed" : goal.status,
    subTasks: goal.subTasks ? goal.subTasks.map((st, i) => ({
      ...st,
      result: results[i] !== undefined ? results[i] : st.result,
      status: results[i] !== undefined ? "done" : st.status,
      ranAt: results[i] !== undefined ? now.toISOString() : st.ranAt,
    })) : goal.subTasks,
  };
  appendJsonlQueued(GOALS_PATH, updated);
  return updated;
}

function _updateGoalStatus(goalId, status) {
  const goals = listGoals();
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return null;
  const updated = { ...goal, status };
  appendJsonlQueued(GOALS_PATH, updated);
  return updated;
}

function completeGoal(goalId) {
  return _updateGoalStatus(goalId, "completed");
}

function pauseGoal(goalId) {
  return _updateGoalStatus(goalId, "paused");
}

function resumeGoal(goalId) {
  return _updateGoalStatus(goalId, "active");
}

async function tickGoals(runSubTask) {
  const due = getGoalsDue();
  const outcomes = [];

  for (const goal of due) {
    const pending = (goal.subTasks || []).filter((st) => st.status === "pending");
    if (pending.length === 0) {
      // All sub-tasks already done; just advance the schedule.
      markGoalRan(goal.id, []);
      outcomes.push({ goalId: goal.id, title: goal.title, result: null });
      continue;
    }

    // Run the next pending sub-task only — subsequent ticks handle the rest,
    // keeping individual tick durations bounded.
    const subTask = pending[0];
    let result = null;
    try {
      result = await runSubTask(goal, subTask);
    } catch (err) {
      result = `error: ${err && err.message ? err.message : String(err)}`;
    }

    const resultsByIndex = [];
    goal.subTasks.forEach((st, i) => {
      if (st.id === subTask.id) resultsByIndex[i] = result;
    });

    markGoalRan(goal.id, resultsByIndex);
    outcomes.push({ goalId: goal.id, title: goal.title, result });
  }

  return outcomes;
}

function startGoalScheduler(runSubTask, intervalMs = 60_000) {
  const handle = setInterval(() => {
    tickGoals(runSubTask).catch((err) => {
      // Scheduler errors must never crash the host process.
      console.error("[goal-engine] tick error:", err);
    });
  }, intervalMs);

  return function stop() {
    clearInterval(handle);
  };
}

module.exports = {
  createGoal,
  listGoals,
  getGoalsDue,
  markGoalRan,
  completeGoal,
  pauseGoal,
  resumeGoal,
  tickGoals,
  startGoalScheduler,
};
