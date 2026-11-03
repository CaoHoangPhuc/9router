import { describe, it, expect } from "vitest";
import {
  isArrayOfUniformObjects,
  isEligibleData,
  convertToToon,
  compressToonMessages,
  formatToonLog,
  hasForbiddenKeys
} from "../../open-sse/rtk/toon.js";

function makeDbRows(count = 5) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push({
      id: i,
      username: `user_${i}`,
      email: `user${i}@example.com`,
      role: i === 1 ? "admin" : "member",
      status: "active",
      score: 85 + i
    });
  }
  return rows;
}

describe("TOON Token Saver", () => {
  describe("isArrayOfUniformObjects (Strict Uniformity & Safety)", () => {
    it("returns true for uniform object array with >= 3 items and identical schemas", () => {
      const rows = makeDbRows(4);
      expect(isArrayOfUniformObjects(rows)).toBe(true);
    });

    it("returns false for array with less than 3 items", () => {
      const rows = makeDbRows(2);
      expect(isArrayOfUniformObjects(rows)).toBe(false);
    });

    it("returns false for primitive arrays", () => {
      expect(isArrayOfUniformObjects([1, 2, 3, 4])).toBe(false);
      expect(isArrayOfUniformObjects(["a", "b", "c"])).toBe(false);
    });

    it("returns false for heterogeneous arrays with mismatched schemas", () => {
      const mixed = [
        { id: 1, name: "Alice" },
        { id: 2, title: "Manager" },
        { id: 3, age: 30 }
      ];
      expect(isArrayOfUniformObjects(mixed)).toBe(false);
    });

    it("returns false if any array element is null or non-object", () => {
      const withNull = [
        { id: 1, name: "A" },
        null,
        { id: 3, name: "C" }
      ];
      expect(isArrayOfUniformObjects(withNull)).toBe(false);

      const withString = [
        { id: 1, name: "A" },
        "not an object",
        { id: 3, name: "C" }
      ];
      expect(isArrayOfUniformObjects(withString)).toBe(false);
    });

    it("returns false when items contain config/manifest keys", () => {
      const configLike = [
        { dependencies: {}, scripts: {} },
        { dependencies: {}, scripts: {} },
        { dependencies: {}, scripts: {} }
      ];
      expect(isArrayOfUniformObjects(configLike)).toBe(false);
    });

    it("returns false when items contain error/stack keys", () => {
      const errorLike = [
        { error: "err1", stack: "stack1" },
        { error: "err2", stack: "stack2" },
        { error: "err3", stack: "stack3" }
      ];
      expect(isArrayOfUniformObjects(errorLike)).toBe(false);
    });

    it("returns false when items contain code/diff keys", () => {
      const diffLike = [
        { hunks: [], diff: "diff1" },
        { hunks: [], diff: "diff2" },
        { hunks: [], diff: "diff3" }
      ];
      expect(isArrayOfUniformObjects(diffLike)).toBe(false);
    });

    it("returns false when an item contains a nested error object", () => {
      const nestedError = [
        { id: 1, diag: { stack: "Error at line 1" } },
        { id: 2, diag: { stack: "Error at line 2" } },
        { id: 3, diag: { stack: "Error at line 3" } }
      ];
      expect(isArrayOfUniformObjects(nestedError)).toBe(false);
    });
  });

  describe("hasForbiddenKeys", () => {
    it("detects forbidden error keys at any depth", () => {
      expect(hasForbiddenKeys({ error: "Failed" })).toBe(true);
      expect(hasForbiddenKeys({ errors: ["Bad"] })).toBe(true);
      expect(hasForbiddenKeys({ nested: { stack: "at foo" } })).toBe(true);
    });

    it("returns false for clean data objects", () => {
      expect(hasForbiddenKeys({ id: 1, name: "Alice", active: true })).toBe(false);
    });
  });

  describe("isEligibleData (Adversarial & Edge Cases)", () => {
    it("accepts root array of uniform objects", () => {
      expect(isEligibleData(makeDbRows(5))).toBe(true);
    });

    it("accepts object wrapping uniform array", () => {
      expect(isEligibleData({
        total: 5,
        page: 1,
        results: makeDbRows(5)
      })).toBe(true);
    });

    it("rejects object with status: 'error' or 'failed'", () => {
      expect(isEligibleData({
        status: "error",
        rows: makeDbRows(5)
      })).toBe(false);

      expect(isEligibleData({
        status: "FAILED",
        rows: makeDbRows(5)
      })).toBe(false);
    });

    it("rejects package.json structure", () => {
      expect(isEligibleData({
        name: "my-package",
        version: "1.0.0",
        scripts: { test: "vitest" },
        dependencies: { react: "^19.0.0" }
      })).toBe(false);
    });

    it("rejects tsconfig.json structure", () => {
      expect(isEligibleData({
        compilerOptions: { target: "es2022" },
        include: ["src"]
      })).toBe(false);
    });

    it("rejects error response objects", () => {
      expect(isEligibleData({
        error: { code: 404, message: "Not found" }
      })).toBe(false);
    });

    it("rejects non-object inputs", () => {
      expect(isEligibleData("just a string")).toBe(false);
      expect(isEligibleData(12345)).toBe(false);
      expect(isEligibleData(null)).toBe(false);
    });
  });

  describe("convertToToon", () => {
    it("returns null for short text (< 150 chars)", () => {
      const shortJson = JSON.stringify([{ id: 1, a: 2 }, { id: 2, a: 3 }, { id: 3, a: 4 }]);
      expect(shortJson.length).toBeLessThan(150);
      expect(convertToToon(shortJson)).toBe(null);
    });

    it("returns null for invalid JSON or non-JSON strings", () => {
      expect(convertToToon("not a json string at all but long enough to pass length check padding padding padding padding padding padding padding padding")).toBe(null);
    });

    it("converts valid DB rows and reduces size significantly", () => {
      const rawJson = JSON.stringify(makeDbRows(6), null, 2);
      expect(rawJson.length).toBeGreaterThan(150);

      const toon = convertToToon(rawJson);
      expect(toon).not.toBeNull();
      expect(toon).toContain("[6]{id,username,email,role,status,score}:");
      expect(toon.length).toBeLessThan(rawJson.length);
    });

    it("converts wrapped records object", () => {
      const rawJson = JSON.stringify({
        status: "success",
        rows: makeDbRows(5)
      }, null, 2);

      const toon = convertToToon(rawJson);
      expect(toon).not.toBeNull();
      expect(toon).toContain("status: success");
      expect(toon).toContain("rows[5]{id,username,email,role,status,score}:");
      expect(toon.length).toBeLessThan(rawJson.length);
    });
  });

  describe("compressToonMessages (Transactional Atomicity)", () => {
    it("returns null when enabled is false", () => {
      const body = {
        messages: [{
          role: "tool",
          content: JSON.stringify(makeDbRows(5), null, 2)
        }]
      };
      const stats = compressToonMessages(body, false);
      expect(stats).toBeNull();
      expect(body.messages[0].content).toContain("user_1");
    });

    it("compresses OpenAI tool message (string content)", () => {
      const originalJson = JSON.stringify(makeDbRows(5), null, 2);
      const body = {
        messages: [
          { role: "user", content: "get users" },
          { role: "tool", content: originalJson }
        ]
      };

      const stats = compressToonMessages(body, true);
      expect(stats).not.toBeNull();
      expect(stats.hits.length).toBe(1);
      expect(stats.hits[0].shape).toBe("openai-tool");
      expect(body.messages[1].content).toContain("[5]{id,username,email,role,status,score}:");
      expect(body.messages[1].content.length).toBeLessThan(originalJson.length);
      // User message must NEVER be touched
      expect(body.messages[0].content).toBe("get users");
    });

    it("compresses Claude tool_result (string content)", () => {
      const originalJson = JSON.stringify(makeDbRows(5), null, 2);
      const body = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_123",
                content: originalJson
              }
            ]
          }
        ]
      };

      const stats = compressToonMessages(body, true);
      expect(stats).not.toBeNull();
      expect(stats.hits.length).toBe(1);
      expect(stats.hits[0].shape).toBe("claude-string");
      expect(body.messages[0].content[0].content).toContain("[5]{id,username,email,role,status,score}:");
    });

    it("skips Claude tool_result when is_error is true", () => {
      const errorJson = JSON.stringify(makeDbRows(5), null, 2);
      const body = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                is_error: true,
                content: errorJson
              }
            ]
          }
        ]
      };

      const stats = compressToonMessages(body, true);
      expect(stats).toBeNull();
      expect(body.messages[0].content[0].content).toBe(errorJson);
    });

    it("compresses OpenAI Responses function_call_output", () => {
      const originalJson = JSON.stringify(makeDbRows(5), null, 2);
      const body = {
        input: [
          {
            type: "function_call_output",
            call_id: "fn_1",
            output: originalJson
          }
        ]
      };

      const stats = compressToonMessages(body, true);
      expect(stats).not.toBeNull();
      expect(stats.hits.length).toBe(1);
      expect(stats.hits[0].shape).toBe("openai-responses-string");
      expect(body.input[0].output).toContain("[5]{id,username,email,role,status,score}:");
    });
  });

  describe("formatToonLog", () => {
    it("returns null for empty stats or 0 hits", () => {
      expect(formatToonLog(null)).toBe(null);
      expect(formatToonLog({ hits: [] })).toBe(null);
    });

    it("formats human-readable savings summary", () => {
      const line = formatToonLog({
        bytesBefore: 1000,
        bytesAfter: 400,
        hits: [{ shape: "openai-tool", saved: 600 }]
      });
      expect(line).toBe("saved 600 chars / 1000 (60.0%) hits=1");
    });
  });
});
