/**
 * Event Queue Consumer — PRL-1 + PRL-1.2 Heartbeat Loop
 *
 * Continuously:
 * 1. Read pending events from queue
 * 2. Check safety gate (stability index >= 0.8)
 * 3. Check idempotency (not already executed)
 * 4. Submit to Trade State Engine
 * 5. [PRL-1.2] Execute trade on Alpaca
 * 6. Record execution result and audit log
 * 7. Mark as EXECUTED
 *
 * This is the heartbeat that guarantees execution.
 * Alpaca is treated as a dumb execution endpoint.
 */

"use strict";

class EventQueueConsumer {
  constructor(queue, idempotency, options = {}) {
    this.queue = queue;
    this.idempotency = idempotency;
    this.tradeEngine = options.tradeEngine || null;
    this.stabilityIndex = options.stabilityIndex || { lastIndex: 0.9 };
    this.auditTracer = options.auditTracer || null;
    this.alpacaAdapter = options.alpacaAdapter || null;
    this.riskGovernor = options.riskGovernor || null;

    this.running = false;
    this.processedCount = 0;
    this.skippedCount = 0;
    this.failedCount = 0;
    this.executedCount = 0;
    this.riskBlockedCount = 0;
    this.lastProcessTime = Date.now();

    // Consumer loop interval (250ms = 4 events/sec max)
    this.loopInterval = 250;
  }

  /**
   * Start the consumer loop
   */
  start() {
    if (this.running) {
      console.log("[Consumer] Already running");
      return;
    }

    this.running = true;
    console.log("[Consumer] Starting heartbeat loop (250ms interval)");

    this._runLoop();
  }

  /**
   * Stop the consumer loop
   */
  stop() {
    this.running = false;
    console.log("[Consumer] Stopped");
  }

  /**
   * Main consumer loop
   */
  _runLoop() {
    if (!this.running) return;

    try {
      this._processBatch();
    } catch (e) {
      console.error("[Consumer] Loop error:", e.message);
    }

    // Schedule next iteration
    setTimeout(() => this._runLoop(), this.loopInterval);
  }

  /**
   * Process a batch of pending events
   */
  _processBatch() {
    const pending = this.queue.getPendingEvents();

    if (pending.length === 0) {
      return; // No work to do
    }

    console.log(`[Consumer] Processing ${Math.min(pending.length, 10)} of ${pending.length} pending events`);

    // Process up to 10 events per batch (non-blocking)
    for (let i = 0; i < Math.min(pending.length, 10); i++) {
      const event = pending[i];
      this._processEvent(event);
    }

    this.lastProcessTime = Date.now();
  }

  /**
   * Process a single event
   */
  async _processEvent(event) {
    const { eventId, payload, traceId } = event;

    // GATE 1: Check if already executed (idempotency guard)
    if (this.idempotency.hasExecuted(eventId)) {
      console.log(`[Consumer] Skipped (already executed): ${eventId}`);
      this.skippedCount++;
      this.queue.markProcessed(eventId, { reason: "already_executed" });
      return;
    }

    // GATE 2: Check safety gate (stability index >= 0.8 required)
    const stabilityIndex = this.stabilityIndex.lastIndex || 0.9;
    const stabilityOk = stabilityIndex >= 0.8;
    if (!stabilityOk) {
      console.log(`[Consumer] Blocked (low stability): ${eventId} (stability: ${stabilityIndex.toFixed(2)})`);
      this.skippedCount++;
      // Don't mark as executed - retry when stability recovers
      return;
    }

    // GATE 3: Validate event schema
    if (!payload.ticker || !payload.action) {
      console.error(`[Consumer] Invalid event schema: ${eventId}`);
      this.failedCount++;
      this.queue.markProcessed(eventId, { reason: "invalid_schema" });
      return;
    }

    try {
      // STEP 1: Create trade in State Engine
      if (!this.tradeEngine) {
        throw new Error("Trade State Engine not initialized");
      }

      const trade = this.tradeEngine.createTrade({
        symbol: payload.ticker,
        side: payload.action.toUpperCase(),
        quantity: payload.quantity || 1,
        price: 0, // Market order
        mode: "paper",
        externalAgent: "independent-ai-trader",
        confidence: payload.confidence,
        strategy: payload.strategy,
        eventId,
        traceId
      });

      // STEP 2: [PRL-1.3] Check Risk Governor (BEFORE execution)
      if (this.riskGovernor) {
        const riskCheck = this.riskGovernor.evaluateTrade(trade, {
          quantity: payload.quantity || 1,
          price: 100, // Will be updated with actual fill price
          notional: (payload.quantity || 1) * 100
        });

        if (!riskCheck.allowed) {
          this.riskBlockedCount++;
          console.warn(`[Consumer] Risk Governor BLOCKED: ${payload.ticker} ${payload.action}`);
          console.warn(`  Reasons: ${riskCheck.reasons.join(", ")}`);

          // Log risk block to audit trail
          if (this.auditTracer) {
            this.auditTracer.recordEvent(
              "RISK_BLOCK",
              "risk-governor",
              {
                symbol: payload.ticker,
                side: payload.action,
                reasons: riskCheck.reasons,
                severity: riskCheck.severity
              },
              trade.tradeId,
              traceId
            );
          }

          // Don't execute, but mark queue event as processed
          this.queue.markProcessed(eventId, {
            reason: "risk_blocked",
            riskReasons: riskCheck.reasons
          });

          return;
        }
      }

      // STEP 3: [PRL-1.2] Execute on Alpaca if adapter available
      let executionResult = null;
      if (this.alpacaAdapter) {
        try {
          executionResult = await this.alpacaAdapter.executeTrade({
            symbol: payload.ticker,
            side: payload.action.toLowerCase(),
            qty: payload.quantity || 1,
            type: "market",
            time_in_force: "day"
          });

          console.log(`[Consumer] Alpaca execution: ${payload.ticker} ${payload.action} (orderId: ${executionResult.orderId}, status: ${executionResult.status})`);

          // Update trade with execution result
          if (this.tradeEngine && this.tradeEngine.updateTrade) {
            this.tradeEngine.updateTrade(trade.tradeId, {
              status: executionResult.status === "filled" ? "FILLED" : "PENDING",
              execution: executionResult,
              brokerOrderId: executionResult.orderId,
              fillPrice: executionResult.avgFillPrice
            });
          }

          // [PRL-1.3] Record execution in risk governor
          if (this.riskGovernor && executionResult.status === "filled") {
            this.riskGovernor.recordExecution(trade, executionResult);
          }
        } catch (execError) {
          console.error(`[Consumer] Alpaca execution failed: ${execError.message}`);
          executionResult = {
            status: "rejected",
            reason: "execution_error",
            message: execError.message
          };
        }
      }

      // STEP 3: Record idempotency (prevents duplicate execution)
      this.idempotency.recordExecution(eventId, trade.tradeId, {
        status: trade.status,
        execution: executionResult,
        timestamp: Date.now()
      });

      // STEP 4: Mark queue event as processed
      this.queue.markProcessed(eventId, {
        tradeId: trade.tradeId,
        status: trade.status,
        execution: executionResult ? executionResult.status : "engine_only"
      });

      // STEP 5: Audit logging (Phase 3.8 integration)
      if (this.auditTracer) {
        try {
          this.auditTracer.recordTradeExecution(
            traceId,
            trade.tradeId,
            {
              status: trade.status,
              stability: stabilityIndex,
              alpaca: executionResult ? {
                orderId: executionResult.orderId,
                status: executionResult.status,
                fillPrice: executionResult.avgFillPrice
              } : null
            },
            true
          );

          // If we executed on Alpaca, log the broker execution event
          if (executionResult && executionResult.orderId) {
            this.auditTracer.recordEvent(
              "BROKER_EXECUTION",
              "alpaca",
              {
                tradeId: trade.tradeId,
                orderId: executionResult.orderId,
                symbol: payload.ticker,
                side: payload.action,
                quantity: payload.quantity || 1,
                status: executionResult.status,
                fillPrice: executionResult.avgFillPrice,
                timestamp: executionResult.timestamp
              },
              trade.tradeId,
              traceId
            );
          }
        } catch (auditError) {
          console.error(`[Consumer] Audit logging error: ${auditError.message}`);
        }
      }

      console.log(`[Consumer] Processed: ${eventId} → ${trade.tradeId} (${payload.ticker} ${payload.action}) [stability: ${stabilityIndex.toFixed(2)}]`);
      this.processedCount++;
      if (executionResult && executionResult.status === "filled") {
        this.executedCount++;
      }

    } catch (e) {
      console.error(`[Consumer] Processing error for ${eventId}:`, e.message);
      this.failedCount++;
      this.queue.markProcessed(eventId, { error: e.message });
    }
  }

  /**
   * Get consumer status
   */
  getStatus() {
    const pending = this.queue.getPendingEvents();

    return {
      running: this.running,
      metrics: {
        processed: this.processedCount,
        executed: this.executedCount,
        riskBlocked: this.riskBlockedCount,
        skipped: this.skippedCount,
        failed: this.failedCount,
        pending: pending.length,
        successRate: this.processedCount > 0
          ? ((this.executedCount / this.processedCount) * 100).toFixed(1) + "%"
          : "N/A",
        riskBlockRate: this.processedCount > 0
          ? ((this.riskBlockedCount / this.processedCount) * 100).toFixed(1) + "%"
          : "N/A"
      },
      alpaca: this.alpacaAdapter ? this.alpacaAdapter.getStats() : null,
      riskGovernor: this.riskGovernor ? this.riskGovernor.getState() : null,
      lastProcessTime: new Date(this.lastProcessTime).toISOString(),
      loopInterval: `${this.loopInterval}ms`
    };
  }

  /**
   * Get detailed statistics
   */
  getStats() {
    return {
      status: this.getStatus(),
      queue: this.queue.getStats(),
      idempotency: this.idempotency.getStats()
    };
  }
}

module.exports = EventQueueConsumer;
