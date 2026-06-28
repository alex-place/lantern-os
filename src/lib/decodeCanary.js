// src/lib/decodeCanary.js

/**
 * Checks for potential model output collapse/repetition and signals if the response should be blocked.
 * This function is part of the anti-collapse infrastructure.
 *
 * @param {string} text The text output from the model to analyze.
 * @returns {{shouldBlock: boolean, reason?: string}} An object indicating if the response should be blocked and why.
 */
const antiCollapseSignal = (text) => {
  const OURO_CANARY_ENABLED = process.env.OURO_CANARY === '1';
  const OURO_CANARY_BLOCKING_ENABLED = process.env.OURO_CANARY_BLOCKING_ENABLED === '1';

  if (!OURO_CANARY_ENABLED) {
    return { shouldBlock: false };
  }

  // Simple heuristic for demonstration: check for very short, repetitive output.
  // In a real scenario, this would involve more sophisticated collapse detection logic.
  const minLengthForCollapse = 20; // Minimum length to consider for collapse
  // const repetitionThreshold = 0.7; // Percentage of text that is repetitive (not used in this simple example)

  if (text.length < minLengthForCollapse) {
    // Too short to reliably detect collapse, or model might just be generating short responses.
    return { shouldBlock: false };
  }

  // Example: Check if the last half of the text is a repetition of the first half
  const halfLength = Math.floor(text.length / 2);
  const firstHalf = text.substring(0, halfLength);
  const secondHalf = text.substring(halfLength);

  // A more robust check would involve n-gram analysis or more complex pattern matching.
  // For this example, let's just do a simple substring check.
  // This checks if a significant portion of the second half is present in the first half,
  // or vice-versa, indicating potential repetition.
  const isRepetitive = firstHalf.includes(secondHalf.substring(0, Math.min(secondHalf.length, 10))) ||
                       secondHalf.includes(firstHalf.substring(0, Math.min(firstHalf.length, 10)));

  if (isRepetitive) {
    const reason = 'Detected potential output collapse/repetition.';
    if (OURO_CANARY_BLOCKING_ENABLED)
