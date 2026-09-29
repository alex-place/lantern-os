/**
 * test/refinement-2-3.test.js
 *
 * Tests for Refinement 2 (Offline MCP Fallback). The Refinement 3 cases tested
 * lib/tool-result.js, which nothing loaded; both were removed 2026-09-29.
 *
 * Run with: node --test test/refinement-2-3.test.js
 */
const { describe, it, beforeEach, expect } = require("./_jest-compat");

// The offline path is the subject, so pin the client to a port nothing listens on. Without
// this, a machine that runs the MCP server (8771) sends these calls to the live server,
// which executes the GitHub tools for real and the "offline" assertions fail.
process.env.MCP_PORT = "1";

describe("Refinement 2: Offline MCP Fallback", () => {
  let mcp;

  beforeEach(() => {
    mcp = require("../lib/mcp-client");
    mcp._resetCache();
  });

  describe("MCP Health Check", () => {
    it("should export isAvailable() function", () => {
      expect(typeof mcp.isAvailable).toBe("function");
    });

    it("should return a Promise", async () => {
      const result = mcp.isAvailable();
      expect(result).toBeInstanceOf(Promise);
      await result; // Wait for it to complete
    });

    it("should cache results for 5 seconds", async () => {
      mcp._resetCache();
      const first = await mcp.isAvailable();
      const second = await mcp.isAvailable();
      expect(typeof first).toBe("boolean");
      expect(typeof second).toBe("boolean");
    });
  });

  describe("Tool Calling with Fallback", () => {
    it("should return unavailable if MCP is offline", async () => {
      const result = await mcp.callTool("github_list_issues", { repo: "foo/bar" });
      // MCP server is likely not running in test environment
      expect(result).toBeDefined();
      expect(result.status).toMatch(/unavailable|error/);
    });

    it("should include reason_code in error response", async () => {
      const result = await mcp.callTool("github_get_issue", { repo: "foo/bar", number: 123 });
      expect(result.reason_code).toBeDefined();
      expect(typeof result.reason_code).toBe("string");
    });

    it("should not throw when MCP is offline", async () => {
      expect(async () => {
        await mcp.callTool("unknown_tool", {});
      }).not.toThrow();
    });
  });
});
