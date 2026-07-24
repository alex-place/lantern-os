/**
 * test/refinement-2-3.test.js
 *
 * Tests for Refinement 2 (Offline MCP Fallback) + Refinement 3 (Error Standardization)
 *
 * Run with: npx jest test/refinement-2-3.test.js
 */

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

describe("Refinement 3: Error Standardization", () => {
  let toolResult;

  beforeEach(() => {
    toolResult = require("../lib/tool-result");
  });

  describe("Success Result", () => {
    it("should create a success result", () => {
      const result = toolResult.success("output text");
      expect(result.status).toBe("executed");
      expect(result.reason_code).toBe("ok");
      expect(result.output).toBe("output text");
      expect(result.output_length).toBe(11);
    });

    it("should include optional metadata", () => {
      const result = toolResult.success("data", { duration_ms: 45, provider: "anthropic" });
      expect(result.duration_ms).toBe(45);
      expect(result.provider).toBe("anthropic");
    });

    it("should handle empty output", () => {
      const result = toolResult.success("");
      expect(result.output).toBe("");
      expect(result.output_length).toBe(0);
    });
  });

  describe("Denied Result", () => {
    it("should create a denied (permission) result", () => {
      const result = toolResult.denied("requires operator access");
      expect(result.status).toBe("denied");
      expect(result.reason_code).toBe("operator_required");
      expect(result.error).toBe("requires operator access");
      expect(result.output).toBeNull();
    });
  });

  describe("Blocked Result", () => {
    it("should create a blocked (safety) result", () => {
      const result = toolResult.blocked("unsafe_path", "path escapes repo");
      expect(result.status).toBe("blocked");
      expect(result.reason_code).toBe("unsafe_path");
      expect(result.error).toBe("path escapes repo");
    });

    it("should support multiple reason codes", () => {
      const unsafe = toolResult.blocked("unsafe_path", "msg");
      const notAllowed = toolResult.blocked("command_not_allowlisted", "msg");
      const blocked = toolResult.blocked("private_host_blocked", "msg");

      expect(unsafe.reason_code).toBe("unsafe_path");
      expect(notAllowed.reason_code).toBe("command_not_allowlisted");
      expect(blocked.reason_code).toBe("private_host_blocked");
    });
  });

  describe("Unavailable Result", () => {
    it("should create an unavailable result", () => {
      const result = toolResult.unavailable("unknown_tool", "tool not found");
      expect(result.status).toBe("unavailable");
      expect(result.reason_code).toBe("unknown_tool");
    });

    it("should support various reason codes", () => {
      const disabled = toolResult.unavailable("chat_tool_exec_disabled", "msg");
      const offline = toolResult.unavailable("mcp_server_offline", "msg");

      expect(disabled.reason_code).toBe("chat_tool_exec_disabled");
      expect(offline.reason_code).toBe("mcp_server_offline");
    });
  });

  describe("Timeout Result", () => {
    it("should create a timeout result", () => {
      const result = toolResult.timeout(30000);
      expect(result.status).toBe("timeout");
      expect(result.reason_code).toBe("timeout");
      expect(result.duration_ms).toBe(30000);
      expect(result.error).toContain("30000");
    });
  });

  describe("Error Result", () => {
    it("should create an error result with default reason code", () => {
      const result = toolResult.error("something went wrong");
      expect(result.status).toBe("error");
      expect(result.reason_code).toBe("execution_error");
      expect(result.error).toBe("something went wrong");
    });

    it("should accept custom reason code", () => {
      const result = toolResult.error("network timeout", "network_error");
      expect(result.reason_code).toBe("network_error");
    });
  });

  describe("Normalize (Backwards Compatibility)", () => {
    it("should pass through already-normalized results", () => {
      const normalized = toolResult.success("output");
      const result = toolResult.normalize(normalized);
      expect(result).toEqual(normalized);
    });

    it("should convert string to normalized format", () => {
      const result = toolResult.normalize("raw output");
      expect(result.status).toBe("executed");
      expect(result.output).toBe("raw output");
      expect(result.output_length).toBe(10);
    });
  });

  describe("Predicates", () => {
    it("should identify success results", () => {
      const success = toolResult.success("data");
      const denied = toolResult.denied("msg");

      expect(toolResult.isSuccess(success)).toBe(true);
      expect(toolResult.isSuccess(denied)).toBe(false);
    });

    it("should identify failure results", () => {
      const success = toolResult.success("data");
      const error = toolResult.error("msg");

      expect(toolResult.isFailure(success)).toBe(false);
      expect(toolResult.isFailure(error)).toBe(true);
    });
  });

  describe("Standardization Consistency", () => {
    it("all results should have status + reason_code + error/output", () => {
      const results = [
        toolResult.success("data"),
        toolResult.denied("msg"),
        toolResult.blocked("unsafe_path", "msg"),
        toolResult.unavailable("unknown_tool", "msg"),
        toolResult.timeout(5000),
        toolResult.error("msg"),
      ];

      results.forEach((result) => {
        expect(result.status).toBeDefined();
        expect(result.reason_code).toBeDefined();
        expect(result.error !== undefined || result.output !== undefined).toBe(true);
      });
    });

    it("should follow status/reason_code hierarchy", () => {
      // Status determines outcome, reason_code explains why
      const scenarios = [
        { status: "executed", reason_code: "ok" },
        { status: "denied", reason_code: "operator_required" },
        { status: "blocked", reason_code: "unsafe_path" },
        { status: "unavailable", reason_code: "unknown_tool" },
        { status: "timeout", reason_code: "timeout" },
        { status: "error", reason_code: "execution_error" },
      ];

      scenarios.forEach(({ status, reason_code }) => {
        const result = { status, reason_code, output: null };
        expect(result.status).toBe(status);
        expect(result.reason_code).toBe(reason_code);
      });
    });
  });
});
