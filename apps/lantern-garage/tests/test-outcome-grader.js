"use strict";
const assert = require("assert");
const { computeBrier, trackECE, computeMultiClassBrier } = require("../lib/outcome-grader");

describe("outcome-grader", () => {
  describe("computeBrier", () => {
    it("should compute Brier score for correct prediction (confidence 1.0, outcome true)", () => {
      const { brier, calibrationMetric } = computeBrier(1.0, true);
      assert.strictEqual(brier, 0);
      assert.strictEqual(calibrationMetric, 0);
    });

    it("should compute Brier score for incorrect prediction (confidence 1.0, outcome false)", () => {
      const { brier, calibrationMetric } = computeBrier(1.0, false);
      assert.strictEqual(brier, 1);
      assert.strictEqual(calibrationMetric, 1);
    });

    it("should compute Brier score for uncertain prediction (confidence 0.5, outcome true)", () => {
      const { brier, calibrationMetric } = computeBrier(0.5, true);
      assert.strictEqual(brier, 0.25);
      assert.strictEqual(calibrationMetric, 0.5);
    });

    it("should compute Brier score for uncertain prediction (confidence 0.5, outcome false)", () => {
      const { brier, calibrationMetric } = computeBrier(0.5, false);
      assert.strictEqual(brier, 0.25);
      assert.strictEqual(calibrationMetric, 0.5);
    });

    it("should handle numeric outcome (0 and 1)", () => {
      const { brier: brier0 } = computeBrier(0.7, 0);
      const { brier: brier1 } = computeBrier(0.7, 1);
      assert.strictEqual(brier0, 0.49);
      assert.strictEqual(brier1, 0.09);
    });

    it
