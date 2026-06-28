class AutoworkLlmError extends Error {
  /**
   * Custom error class for LLM-related failures in Autowork.
   * @param {string} message - A human-readable error message.
   * @param {object} details - Detailed error information.
   * @param {string} [details.providerName] - The name of the LLM provider (e.g., 'VertexAI').
   * @param {number} [details.statusCode] - The HTTP status code of the error (if
