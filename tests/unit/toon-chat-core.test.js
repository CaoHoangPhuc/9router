import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/dataDir.js", () => ({
  DATA_DIR: "/tmp/test-9router-data",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

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

describe("TOON Token Saver in chatCore pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        choices: [{ message: { role: "assistant", content: "ok" } }]
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      transformedBody: null,
    });
  });

  it("compresses tool_result with TOON when toonEnabled is true and logs TOON flag", async () => {
    const rawJson = JSON.stringify(makeDbRows(5), null, 2);
    const logLines = [];
    const mockLog = {
      line: (tag, symbol, text) => logLines.push({ tag, symbol, text }),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const body = {
      model: "claude-3-7-sonnet",
      stream: false,
      messages: [
        { role: "user", content: "List all users" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "query_db", input: { query: "SELECT * FROM users" } }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: rawJson
            }
          ]
        }
      ]
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "anthropic", model: "claude-3-7-sonnet" },
      credentials: {},
      log: mockLog,
      rtkEnabled: false,
      toonEnabled: true,
    });

    expect(executeMock).toHaveBeenCalled();
    const executedBody = executeMock.mock.calls[0][0].body;
    
    // Tool result must be compressed to TOON
    const toolMsg = executedBody.messages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_result"));
    expect(toolMsg).toBeDefined();
    const toolResultBlock = toolMsg.content.find(b => b.type === "tool_result");
    expect(toolResultBlock.content).toContain("[5]{id,username,email,role,status,score}:");
    expect(toolResultBlock.content.length).toBeLessThan(rawJson.length);

    // ⚙ Log line must include TOON:1
    const gearLine = logLines.find(l => l.symbol === "⚙");
    expect(gearLine).toBeDefined();
    expect(gearLine.text).toContain("TOON:1");
  });

  it("leaves tool_result untouched when toonEnabled is false", async () => {
    const rawJson = JSON.stringify(makeDbRows(5), null, 2);
    const logLines = [];
    const mockLog = {
      line: (tag, symbol, text) => logLines.push({ tag, symbol, text }),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const body = {
      model: "claude-3-7-sonnet",
      stream: false,
      messages: [
        { role: "user", content: "List all users" },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: rawJson
            }
          ]
        }
      ]
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "anthropic", model: "claude-3-7-sonnet" },
      credentials: {},
      log: mockLog,
      rtkEnabled: false,
      toonEnabled: false,
    });

    expect(executeMock).toHaveBeenCalled();
    const executedBody = executeMock.mock.calls[0][0].body;
    const toolMsg = executedBody.messages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_result"));
    const toolResultBlock = toolMsg.content.find(b => b.type === "tool_result");
    expect(toolResultBlock.content).toBe(rawJson);

    // No TOON flag in gear line
    const gearLine = logLines.find(l => l.symbol === "⚙");
    if (gearLine) {
      expect(gearLine.text).not.toContain("TOON");
    }
  });

  it("NEVER touches user prompts containing JSON code blocks", async () => {
    const userPromptWithJson = 'Can you fix this JSON?\n```json\n' + JSON.stringify(makeDbRows(5), null, 2) + '\n```';
    const mockLog = {
      line: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const body = {
      model: "claude-3-7-sonnet",
      stream: false,
      messages: [
        { role: "user", content: userPromptWithJson }
      ]
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "anthropic", model: "claude-3-7-sonnet" },
      credentials: {},
      log: mockLog,
      rtkEnabled: true,
      toonEnabled: true,
    });

    expect(executeMock).toHaveBeenCalled();
    const executedBody = executeMock.mock.calls[0][0].body;
    const userMsg = executedBody.messages.find(m => m.role === "user");
    // Must remain 100% byte-for-byte identical to what user wrote
    const textContent = typeof userMsg.content === "string" ? userMsg.content : userMsg.content[0].text;
    expect(textContent).toBe(userPromptWithJson);
  });
});
