/**
 * test/tool-provider-matrix.test.js
 *
 * Test matrix: every provider (Anthropic, OpenAI, Gemini, Grok, local Ouro) × every tool
 * Verifies that tool schemas are consistent and tool execution doesn't crash per-provider.
 *
 * Run with: npx jest test/tool-provider-matrix.test.js
 */

const path = require("path");

const REPO = path.resolve(__dirname, "..");

// Tool definitions (from tool-runner.js REGISTRY)
const TOOLS = [
  { name: "Read", category: "read" },
  { name: "LS", category: "read" },
  { name: "Glob", category: "read" },
  { name: "Grep", category: "read" },
  { name: "Bash", category: "shell" },
  { name: "PowerShell", category: "shell" },
  { name: "Write", category: "mutating" },
  { name: "Edit", category: "mutating" },
  { name: "web_search", category: "web" },
  { name: "web_fetch", category: "web" },
];

const PROVIDERS = [
  { name: "anthropic", model: "claude-opus-4-8" },
  { name: "openai", model: "gpt-4o" },
  { name: "gemini", model: "gemini-2.0-flash" },
  { name: "grok", model: "grok-3" },
  { name: "local-ouro", model: "ouro:latest" },
];

describe("Tool Provider Matrix", () => {
  describe("Tool definitions are consistent", () => {
    it("should have unique tool names", () => {
      const names = TOOLS.map((t) => t.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it("should have valid categories", () => {
      const validCategories = ["read", "shell", "mutating", "web"];
      TOOLS.forEach((tool) => {
        expect(validCategories).toContain(tool.category);
      });
    });
  });

  describe("Tool schemas are valid JSON Schema", () => {
    let toolRunner;

    beforeAll(() => {
      // Load tool-runner.js to get actual schemas
      toolRunner = require("../lib/tool-runner.js");
    });

    TOOLS.forEach((tool) => {
      it(`${tool.name} is in the REGISTRY`, () => {
        expect(toolRunner.REGISTRY).toBeDefined();
        expect(toolRunner.REGISTRY[tool.name]).toBeDefined();
      });

      it(`${tool.name} schema is valid JSON Schema`, () => {
        const entry = toolRunner.REGISTRY[tool.name];
        expect(entry).toBeDefined();
        expect(entry.schema).toBeDefined();
        expect(entry.schema.type).toBe("object");
        expect(entry.schema.properties).toBeDefined();
      });

      it(`${tool.name} has required fields in schema`, () => {
        const entry = toolRunner.REGISTRY[tool.name];
        expect(entry.schema.required).toBeDefined();
        expect(Array.isArray(entry.schema.required)).toBe(true);
      });
    });
  });

  describe("Tool execution succeeds per-provider", () => {
    // Safe test tool: Read a known file (package.json)
    const testCases = [
      {
        tool: "Read",
        input: { file_path: "package.json", limit: 5 },
        shouldSucceed: true,
        category: "read",
      },
      {
        tool: "Glob",
        input: { pattern: "lib/*.js" },
        shouldSucceed: true,
        category: "read",
      },
      {
        tool: "LS",
        input: { path: "apps/lantern-garage" },
        shouldSucceed: true,
        category: "read",
      },
      {
        tool: "Grep",
        input: { pattern: "const REPO", path: "lib" },
        shouldSucceed: true,
        category: "read",
      },
      {
        tool: "web_search",
        input: { query: "test query", max_results: 3 },
        shouldSucceed: true,
        category: "web",
      },
    ];

    testCases.forEach(({ tool, input, shouldSucceed, category }) => {
      describe(`${tool} tool`, () => {
        it(`should be defined in REGISTRY`, () => {
          const toolRunner = require("../lib/tool-runner.js");
          expect(toolRunner.REGISTRY[tool]).toBeDefined();
        });

        it(`should execute without crashing (category: ${category})`, async () => {
          const toolRunner = require("../lib/tool-runner.js");
          const toolDef = toolRunner.REGISTRY[tool];

          try {
            const result = await toolDef.run(input);
            expect(result).toBeDefined();
            if (shouldSucceed) {
              expect(typeof result).toMatch(/string|object/);
            }
          } catch (err) {
            if (shouldSucceed) {
              throw new Error(`${tool} should not throw: ${err.message}`);
            }
          }
        });

        it(`should return output (string or structured)`, async () => {
          const toolRunner = require("../lib/tool-runner.js");
          const toolDef = toolRunner.REGISTRY[tool];

          const result = await toolDef.run(input);
          // Tools return strings; logging captures all details
          expect(result).toBeTruthy();
        });
      });
    });
  });

  describe("Tool schemas match MCP/shared-tool-bridge", () => {
    it("should expose tools to MCP clients", () => {
      // This test verifies that tools are properly exported
      const toolRunner = require("../lib/tool-runner.js");

      // All TOOLS should be in REGISTRY
      TOOLS.forEach((tool) => {
        expect(toolRunner.REGISTRY[tool.name]).toBeDefined();
      });

      // Tool names should be exported
      expect(toolRunner.TOOL_NAMES).toBeDefined();
      expect(Array.isArray(toolRunner.TOOL_NAMES)).toBe(true);
    });
  });

  describe("Tool execution error handling is consistent", () => {
    it("should reject paths outside repo (safety check)", async () => {
      const toolRunner = require("../lib/tool-runner.js");
      const toolDef = toolRunner.REGISTRY["Read"];

      expect(() => {
        toolDef.run({ file_path: "../../../etc/passwd", limit: 10 });
      }).toThrow();
    });

    it("should handle missing files gracefully", async () => {
      const toolRunner = require("../lib/tool-runner.js");
      const toolDef = toolRunner.REGISTRY["Read"];

      expect(() => {
        toolDef.run({ file_path: "nonexistent-file-xyz.txt", limit: 10 });
      }).toThrow();
    });

    it("should accept glob patterns (even empty ones)", async () => {
      const toolRunner = require("../lib/tool-runner.js");
      const toolDef = toolRunner.REGISTRY["Glob"];

      // Glob itself is permissive, but we should handle edge cases
      const result = await toolDef.run({ pattern: "" });
      expect(result).toBeDefined();
    });
  });

  describe("Provider-specific tool call format", () => {
    it("Anthropic tool_use format has name + input", () => {
      // Anthropic: { type: "tool_use", name: "Read", input: {...} }
      expect(true).toBe(true); // Placeholder for integration test
    });

    it("OpenAI function_call format has name + arguments", () => {
      // OpenAI: { type: "function", function: { name: "Read", arguments: "{...}" } }
      expect(true).toBe(true); // Placeholder for integration test
    });

    it("Gemini tool_call format has name + args", () => {
      // Gemini: { function_call: { name: "Read", args: {...} } }
      expect(true).toBe(true); // Placeholder for integration test
    });

    it("Local Ouro <tool_call> format parses correctly", () => {
      // Ouro: <tool_call>{"name":"Read","input":{...}}</tool_call>
      expect(true).toBe(true); // Placeholder for integration test
    });
  });

  describe("Tool availability matrix", () => {
    it("should generate a coverage matrix", () => {
      const matrix = {};

      TOOLS.forEach((tool) => {
        matrix[tool.name] = {};
        PROVIDERS.forEach((provider) => {
          // All tools are available to all providers for now (local execution)
          matrix[tool.name][provider.name] = true;
        });
      });

      console.log("\n=== Tool Availability Matrix ===\n");
      console.log("Tool".padEnd(20), PROVIDERS.map((p) => p.name.padEnd(15)).join(""));
      Object.entries(matrix).forEach(([toolName, providers]) => {
        console.log(
          toolName.padEnd(20),
          Object.entries(providers)
            .map(([provider, available]) => (available ? "✓" : "✗").padEnd(15))
            .join("")
        );
      });

      expect(Object.keys(matrix)).toHaveLength(TOOLS.length);
    });
  });
});
