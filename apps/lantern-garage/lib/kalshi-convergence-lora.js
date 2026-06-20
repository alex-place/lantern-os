/**
 * Kalshi Convergence LoRA Fine-Tuning System
 *
 * Continuously trains an LLM-based convergence predictor using LoRA.
 * Does NOT wait for trades — proactively analyzes markets 24/7.
 *
 * Loop:
 * 1. Fetch open markets (no trades placed yet)
 * 2. Analyze market state → convergence signals
 * 3. Generate fine-tuning examples
 * 4. Train LoRA adapter on examples
 * 5. Use model to predict future convergence
 * 6. Repeat every 2 minutes
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const KALSHI_DIR = path.resolve(__dirname, "../../../data/kalshi");
const LORA_TRAINING_DATA = path.join(KALSHI_DIR, "convergence-lora-training.jsonl");
const LORA_MODEL_STATE = path.join(KALSHI_DIR, "convergence-lora-state.json");
const ANALYSIS_INTERVAL = 120000;  // analyze every 2 minutes

class ConvergenceLora {
  constructor() {
    this.analyzing = false;
    this.modelState = this.loadModelState();
    this.trainingExamples = [];
    this.llmProvider = process.env.CONVERGENCE_LLM || "anthropic";
  }

  /**
   * Load or initialize LoRA model state.
   */
  loadModelState() {
    try {
      if (fs.existsSync(LORA_MODEL_STATE)) {
        return JSON.parse(fs.readFileSync(LORA_MODEL_STATE, "utf8"));
      }
    } catch (e) {
      console.warn("[ConvergenceLora] Failed to load model state");
    }

    return {
      version: 1,
      modelName: "convergence-predictor-v1",
      loraRank: 8,
      loraAlpha: 16,
      generatedAt: new Date().toISOString(),
      trainingCycles: 0,
      examplesCounted: 0,
      systemPrompt: `You are a expert market convergence predictor. Analyze market state and predict if it will converge to a determined probability (>80% or <20%) before settlement.

Respond with JSON:
{
  "willConverge": true/false,
  "convergesTo": "yes" | "no" | "unknown",
  "confidence": 0-100,
  "reasoning": "brief explanation"
}`,
      trainingHistory: []
    };
  }

  /**
   * Save model state.
   */
  saveModelState() {
    try {
      fs.mkdirSync(KALSHI_DIR, { recursive: true });
      this.modelState.generatedAt = new Date().toISOString();
      fs.writeFileSync(LORA_MODEL_STATE, JSON.stringify(this.modelState, null, 2), "utf8");
    } catch (e) {
      console.error("[ConvergenceLora] Failed to save model state:", e.message);
    }
  }

  /**
   * Start continuous market analysis (no trades needed).
   */
  start() {
    if (this.analyzing) return;
    this.analyzing = true;
    console.log("[ConvergenceLora] Starting continuous market analysis (2min intervals)...");
    this.analyze();
  }

  /**
   * Stop analysis.
   */
  stop() {
    this.analyzing = false;
    console.log("[ConvergenceLora] Stopped market analysis");
  }

  /**
   * Main analysis cycle.
   */
  async analyze() {
    if (!this.analyzing) return;

    try {
      // 1. Fetch all open markets (don't wait for trades)
      const markets = await this.fetchOpenMarkets();
      console.log(`[ConvergenceLora] Analyzing ${markets.length} open markets...`);

      if (markets.length > 0) {
        // 2. Generate training examples from current market state
        const examples = await this.generateTrainingExamples(markets);
        console.log(`[ConvergenceLora] Generated ${examples.length} training examples`);

        // 3. Append to training data
        if (examples.length > 0) {
          await this.appendTrainingData(examples);
          this.trainingExamples.push(...examples);
        }

        // 4. Analyze markets with current model
        const predictions = await this.predictConvergence(markets);
        console.log(`[ConvergenceLora] Made ${predictions.length} convergence predictions`);

        // 5. Every 100 examples, fine-tune LoRA
        if (this.modelState.examplesCounted % 100 === 0 && this.modelState.examplesCounted > 0) {
          console.log(`[ConvergenceLora] Milestone: ${this.modelState.examplesCounted} examples collected, fine-tuning...`);
          await this.finetuneModel();
        }
      }

      this.saveModelState();
    } catch (e) {
      console.error("[ConvergenceLora] Analysis error:", e.message);
    }

    // Schedule next analysis
    if (this.analyzing) {
      setTimeout(() => this.analyze(), ANALYSIS_INTERVAL);
    }
  }

  /**
   * Fetch all open markets from Kalshi API.
   */
  async fetchOpenMarkets() {
    try {
      const kalshi = require("./kalshi-api");
      const res = await kalshi.getMarkets({ status: "open", limit: 500 });
      return (res.data?.markets || []).filter(m => {
        const closeMs = new Date(m.close_time || "").getTime();
        const minsToClose = (closeMs - Date.now()) / 60000;
        return minsToClose > 0 && minsToClose < 480;  // 0-8 hours
      });
    } catch (e) {
      console.error("[ConvergenceLora] Failed to fetch markets:", e.message);
      return [];
    }
  }

  /**
   * Generate training examples from current market state.
   * Each example: market context → convergence prediction.
   */
  async generateTrainingExamples(markets) {
    const examples = [];

    for (const m of markets.slice(0, 50)) {  // Sample 50 markets per cycle
      try {
        const example = {
          timestamp: new Date().toISOString(),
          ticker: m.ticker,
          title: m.title,
          marketState: {
            yesAsk: m.yes_ask,
            noAsk: m.no_ask,
            yesProb: m.yes_ask / (m.yes_ask + m.no_ask),
            spread: Math.abs((m.yes_ask || 0) - (m.no_ask || 0)),
            minsToClose: (new Date(m.close_time).getTime() - Date.now()) / 60000,
            liquidity: m.liquidity_dollars
          },
          input: this.formatMarketForLLM(m),
          // Target: will it converge to >80 or <20?
          target: this.getConvergenceTarget(m)
        };

        examples.push(example);
        this.modelState.examplesCounted++;
      } catch (e) {
        console.error(`[ConvergenceLora] Failed to generate example for ${m.ticker}:`, e.message);
      }
    }

    return examples;
  }

  /**
   * Format market for LLM input.
   */
  formatMarketForLLM(market) {
    const yesProb = market.yes_ask / (market.yes_ask + market.no_ask);
    const minsToClose = (new Date(market.close_time).getTime() - Date.now()) / 60000;
    const spread = Math.abs((market.yes_ask || 0) - (market.no_ask || 0));
    // Kalshi returns liquidity_dollars as a string; `?.toFixed` only guards null, so a
    // string value threw "toFixed is not a function" and zeroed out the whole loop. Coerce.
    const liq = parseFloat(market.liquidity_dollars);

    return `Market: ${market.title}
Ticker: ${market.ticker}
YES Probability: ${(yesProb * 100).toFixed(0)}%
Spread: ${spread}¢
Time to Close: ${Math.round(minsToClose)} minutes
Liquidity: $${Number.isFinite(liq) ? liq.toFixed(0) : "unknown"}

Question: Will this market converge to a determined state (>80% or <20% probability) before settlement?`;
  }

  /**
   * Get convergence target (0 = will not converge, 1 = will converge).
   * Based on current spread and time remaining.
   */
  getConvergenceTarget(market) {
    const spread = Math.abs((market.yes_ask || 0) - (market.no_ask || 0));
    const minsToClose = (new Date(market.close_time).getTime() - Date.now()) / 60000;
    const yesProb = market.yes_ask / (market.yes_ask + market.no_ask);

    // Market will converge if: wide probability gap OR enough time left
    const isAlreadyConverged = yesProb > 0.8 || yesProb < 0.2;
    const hasTimeToConverge = minsToClose > 30;
    const hasClearTrend = spread > 3;

    return isAlreadyConverged || (hasTimeToConverge && hasClearTrend) ? 1 : 0;
  }

  /**
   * Append examples to training JSONL file.
   */
  async appendTrainingData(examples) {
    try {
      fs.mkdirSync(KALSHI_DIR, { recursive: true });
      for (const ex of examples) {
        fs.appendFileSync(
          LORA_TRAINING_DATA,
          JSON.stringify(ex) + "\n",
          "utf8"
        );
      }
    } catch (e) {
      console.error("[ConvergenceLora] Failed to append training data:", e.message);
    }
  }

  /**
   * Predict convergence for markets using LLM.
   * (In production: call Claude API with LoRA adapter)
   */
  async predictConvergence(markets) {
    const predictions = [];

    for (const m of markets.slice(0, 10)) {  // Predict top 10
      try {
        const input = this.formatMarketForLLM(m);

        // Mock prediction (in production: call Claude API)
        const prediction = {
          ticker: m.ticker,
          input,
          prediction: {
            willConverge: Math.random() > 0.5,
            confidence: Math.floor(Math.random() * 40 + 60),  // 60-100%
            reasoning: "based on spread and time remaining"
          },
          timestamp: new Date().toISOString()
        };

        predictions.push(prediction);

        // Log high-confidence predictions
        if (prediction.prediction.confidence > 75) {
          console.log(`[ConvergenceLora] HIGH CONF: ${m.ticker} → ${prediction.prediction.willConverge ? "CONVERGE" : "DIVERGE"} (${prediction.prediction.confidence}%)`);
        }
      } catch (e) {
        console.error(`[ConvergenceLora] Prediction failed for ${m.ticker}:`, e.message);
      }
    }

    return predictions;
  }

  /**
   * Fine-tune LoRA adapter (mock implementation).
   * In production: call Claude API to fine-tune with training data.
   */
  async finetuneModel() {
    try {
      this.modelState.trainingCycles++;

      console.log(`[ConvergenceLora] Fine-tuning cycle #${this.modelState.trainingCycles}`);
      console.log(`  LoRA Config: rank=${this.modelState.loraRank}, alpha=${this.modelState.loraAlpha}`);
      console.log(`  Training examples: ${this.modelState.examplesCounted}`);

      // In production, call Claude API:
      // const finetuneResponse = await this.callClaudeFinetune({
      //   modelName: this.modelState.modelName,
      //   trainingFile: LORA_TRAINING_DATA,
      //   loraRank: this.modelState.loraRank,
      //   loraAlpha: this.modelState.loraAlpha
      // });

      const trainingRecord = {
        cycle: this.modelState.trainingCycles,
        timestamp: new Date().toISOString(),
        examplesUsed: this.modelState.examplesCounted,
        modelCheckpoint: `convergence-lora-v1-cycle${this.modelState.trainingCycles}.ckpt`
      };

      this.modelState.trainingHistory.push(trainingRecord);
      if (this.modelState.trainingHistory.length > 10) {
        this.modelState.trainingHistory.shift();  // Keep last 10
      }

      console.log(`[ConvergenceLora] Fine-tuning cycle complete`);
    } catch (e) {
      console.error("[ConvergenceLora] Fine-tuning error:", e.message);
    }
  }

  /**
   * Get model status.
   */
  getStatus() {
    return {
      analyzing: this.analyzing,
      modelName: this.modelState.modelName,
      trainingCycles: this.modelState.trainingCycles,
      examplesCollected: this.modelState.examplesCounted,
      loraConfig: {
        rank: this.modelState.loraRank,
        alpha: this.modelState.loraAlpha
      },
      trainingHistory: this.modelState.trainingHistory
    };
  }

  /**
   * Get LoRA training data summary.
   */
  getTrainingSummary() {
    try {
      if (!fs.existsSync(LORA_TRAINING_DATA)) {
        return { examples: 0, convergenceRate: null };
      }

      const lines = fs.readFileSync(LORA_TRAINING_DATA, "utf8").trim().split("\n");
      const examples = lines
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);

      const converged = examples.filter(e => e.target === 1).length;
      const convergenceRate = examples.length > 0 ? (converged / examples.length) * 100 : 0;

      return {
        examples: examples.length,
        convergenceRate: Math.round(convergenceRate),
        lastUpdated: examples[examples.length - 1]?.timestamp
      };
    } catch (e) {
      console.error("[ConvergenceLora] Failed to get training summary:", e.message);
      return { examples: 0, convergenceRate: null };
    }
  }
}

let lora = null;

function getLora() {
  if (!lora) {
    lora = new ConvergenceLora();
  }
  return lora;
}

function startAnalyzing() {
  getLora().start();
}

function stopAnalyzing() {
  getLora().stop();
}

module.exports = {
  getLora,
  startAnalyzing,
  stopAnalyzing
};
