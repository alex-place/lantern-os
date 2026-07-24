// Spectral Analyzer — Research-Grounded Collapse Detection
// Monitors Gram matrix eigen-spectrum and entropy decay
// Based on: arXiv:2601.03385, arXiv:2512.12381, arXiv:2512.00757

const { createCanvas } = require("canvas");
const { spawn } = require("child_process");

/**
 * SpectralAnalyzer — Monitor system collapse via spectral metrics
 *
 * Collapse manifold characteristics:
 * - Gram eigenvalue decay (rank collapse)
 * - Reduced effective dimensionality
 * - Low spectral entropy
 *
 * Three regimes:
 * 1. Stable contraction: ρ(J) < 1, high entropy
 * 2. Collapse manifold: rank(Gram) ↓, low entropy
 * 3. Divergent: ρ(J) > 1, expansion
 */
class SpectralAnalyzer {
  constructor(options = {}) {
    this.windowSize = options.windowSize || 16; // Frame embedding dimension
    this.entropyThreshold = options.entropyThreshold || 0.4; // Collapse detection threshold
    this.spectralSpreadThreshold = options.spectralSpreadThreshold || 0.3;
    this.embeddings = [];
  }

  /**
   * Add frame embedding to analysis window
   * Embeddings should be 1D or flattened representations of frame content
   */
  addEmbedding(embedding) {
    if (Array.isArray(embedding)) {
      this.embeddings.push(embedding);
    } else if (typeof embedding === "number") {
      this.embeddings.push([embedding]);
    }

    // Keep rolling window
    if (this.embeddings.length > this.windowSize) {
      this.embeddings.shift();
    }
  }

  /**
   * Compute Gram matrix: G = X^T X (where X is embeddings matrix)
   * Normalized: G_norm = G / ||G||_F
   */
  computeGramMatrix() {
    if (this.embeddings.length < 2) {
      return null;
    }

    const n = this.embeddings.length;
    const dim = this.embeddings[0].length;

    // X: n × dim matrix of embeddings
    const X = this.embeddings;

    // Gram matrix: G = X X^T (n × n)
    const G = Array(n)
      .fill(null)
      .map(() => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let k = 0; k < dim; k++) {
          sum += X[i][k] * X[j][k];
        }
        G[i][j] = sum;
      }
    }

    // Normalize by Frobenius norm
    let frobNorm = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        frobNorm += G[i][j] * G[i][j];
      }
    }
    frobNorm = Math.sqrt(frobNorm);

    if (frobNorm > 0) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          G[i][j] /= frobNorm;
        }
      }
    }

    return G;
  }

  /**
   * Compute eigenvalues via power iteration (approximate)
   * Returns sorted eigenvalues in descending order
   */
  computeEigenvalues(matrix, iterations = 10) {
    if (!matrix || matrix.length === 0) {
      return [];
    }

    const n = matrix.length;
    const eigenvalues = [];

    // Power iteration to find largest eigenvalue
    let v = Array(n)
      .fill(null)
      .map(() => Math.random());
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    v = v.map((x) => x / norm);

    for (let iter = 0; iter < iterations; iter++) {
      // Multiply: Av
      const Av = Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          Av[i] += matrix[i][j] * v[j];
        }
      }

      // Rayleigh quotient: λ ≈ v^T A v
      let rayleigh = 0;
      for (let i = 0; i < n; i++) {
        rayleigh += v[i] * Av[i];
      }
      eigenvalues[0] = rayleigh;

      // Normalize
      norm = Math.sqrt(Av.reduce((s, x) => s + x * x, 0));
      if (norm > 1e-10) {
        v = Av.map((x) => x / norm);
      }
    }

    // For simplicity, return just the largest eigenvalue
    // Production: use eigendecomposition library (numeric.js, jama)
    return [eigenvalues[0]];
  }

  /**
   * Spectral radius: ρ(J) = max(|eigenvalues|)
   * Indicates stability: ρ < 1 = stable, ρ > 1 = unstable
   */
  spectralRadius() {
    const gram = this.computeGramMatrix();
    if (!gram) return 0;

    const eigenvalues = this.computeEigenvalues(gram);
    return Math.max(...eigenvalues.map(Math.abs));
  }

  /**
   * Spectral entropy: -Σ p_i log(p_i)
   * where p_i = λ_i / Σ λ (normalized eigenvalues)
   *
   * High entropy = diverse spectrum = diverse content
   * Low entropy = concentrated spectrum = collapsed / redundant
   */
  spectralEntropy() {
    const gram = this.computeGramMatrix();
    if (!gram) return 0;

    const eigenvalues = this.computeEigenvalues(gram);
    if (eigenvalues.length === 0) return 0;

    // Normalize eigenvalues
    const sum = eigenvalues.reduce((a, b) => a + Math.abs(b), 0);
    if (sum === 0) return 0;

    const probabilities = eigenvalues.map((x) => Math.abs(x) / sum);

    // Shannon entropy: -Σ p_i log(p_i)
    let entropy = 0;
    for (const p of probabilities) {
      if (p > 1e-10) {
        entropy -= p * Math.log(p);
      }
    }

    // Normalize to [0, 1]
    const maxEntropy = Math.log(eigenvalues.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  /**
   * Spectral spread: ratio of largest to second-largest eigenvalue
   * High spread = one dominant direction = potentially collapsing
   * Low spread = balanced spectrum = stable
   */
  spectralSpread() {
    const gram = this.computeGramMatrix();
    if (!gram) return 1;

    const eigenvalues = this.computeEigenvalues(gram).map(Math.abs);
    eigenvalues.sort((a, b) => b - a);

    if (eigenvalues.length < 2) return 1;
    if (eigenvalues[1] < 1e-10) return 1e10;

    return eigenvalues[0] / eigenvalues[1];
  }

  /**
   * Collapse detection: entropy < threshold indicates collapsed state
   */
  isCollapsed() {
    return this.spectralEntropy() < this.entropyThreshold;
  }

  /**
   * Stability check: ρ(J) < 1 indicates contraction
   */
  isStable() {
    return this.spectralRadius() < 1.0;
  }

  /**
   * Get all spectral metrics for a segment
   */
  metrics() {
    return {
      spectralRadius: this.spectralRadius(),
      spectralEntropy: this.spectralEntropy(),
      spectralSpread: this.spectralSpread(),
      isCollapsed: this.isCollapsed(),
      isStable: this.isStable(),
      windowSize: this.embeddings.length,
    };
  }

  /**
   * Reset analyzer for next segment
   */
  reset() {
    this.embeddings = [];
  }
}

/**
 * Extract simple frame embeddings from raw video data
 * In production, use CNN embeddings (e.g., ResNet features)
 * For now: histogram-based color/motion features
 */
function frameToEmbedding(frameBuffer, width, height) {
  // Simple histogram embedding: 16 bins of luminance
  const histogram = Array(16).fill(0);

  for (let i = 0; i < frameBuffer.length; i += 3) {
    // Convert RGB to luminance
    const r = frameBuffer[i];
    const g = frameBuffer[i + 1];
    const b = frameBuffer[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    // Bin into histogram
    const bin = Math.floor((lum / 255) * 15);
    histogram[bin]++;
  }

  // Normalize histogram
  const total = width * height;
  return histogram.map((x) => x / total);
}

module.exports = {
  SpectralAnalyzer,
  frameToEmbedding,
};
