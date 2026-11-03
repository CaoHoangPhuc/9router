// TOON (Token-Oriented Object Notation) Token Saver
// Losslessly converts uniform tabular/array JSON data inside tool_results
// into compact TOON tables, saving 30-60% tokens without affecting model reasoning.

import { encode } from "@toon-format/toon";

export const MIN_TOON_SIZE = 150;      // Skip tiny strings (< 150 chars)
export const MAX_TOON_SIZE = 500000;   // Skip huge files to protect memory

// Guard against configs, system manifests, error traces, or code ASTs
const CONFIG_KEYS = new Set([
  "dependencies", "devDependencies", "peerDependencies", "optionalDependencies",
  "scripts", "compilerOptions", "repository", "engines", "eslintConfig",
  "keywords", "publishConfig", "husky", "browserslist", "exports"
]);

const ERROR_KEYS = new Set([
  "stack", "trace", "exception", "errno", "syscall", "stderr", "callsite"
]);

const CODE_KEYS = new Set([
  "hunks", "diff", "patch", "ast", "tokens"
]);

/**
 * Checks whether an array consists of uniform objects suitable for tabular TOON formatting.
 */
export function isArrayOfUniformObjects(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return false;

  let objectCount = 0;
  for (const item of arr) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      objectCount++;
    }
  }
  // At least 80% must be objects
  if (objectCount / arr.length < 0.8) return false;

  const firstKeys = Object.keys(arr[0] || {});
  if (firstKeys.length < 2) return false; // Needs at least 2 columns to be a meaningful table

  // Guard against config / error / code
  for (const k of firstKeys) {
    if (CONFIG_KEYS.has(k) || ERROR_KEYS.has(k) || CODE_KEYS.has(k)) return false;
  }

  // Check key overlap across first few items (must share keys)
  const firstKeySet = new Set(firstKeys);
  const sampleCount = Math.min(arr.length, 5);
  for (let i = 1; i < sampleCount; i++) {
    const item = arr[i];
    if (!item || typeof item !== "object") continue;
    const keys = Object.keys(item);
    let match = 0;
    for (const k of keys) {
      if (firstKeySet.has(k)) match++;
    }
    if (match === 0) return false;
  }

  return true;
}

/**
 * Verifies whether the parsed JSON data is safe and beneficial for TOON encoding.
 */
export function isEligibleData(parsed) {
  if (!parsed || typeof parsed !== "object") return false;

  if (Array.isArray(parsed)) {
    return isArrayOfUniformObjects(parsed);
  }

  // Top-level object wrapping an array of uniform objects (e.g., { total: 10, rows: [...] })
  const topKeys = Object.keys(parsed);
  if (topKeys.length > 5) return false;

  for (const k of topKeys) {
    if (CONFIG_KEYS.has(k) || ERROR_KEYS.has(k) || CODE_KEYS.has(k)) return false;
  }

  for (const k of topKeys) {
    if (isArrayOfUniformObjects(parsed[k])) return true;
  }

  return false;
}

/**
 * Attempts to parse and encode text into TOON.
 * Returns encoded TOON string on success, or null if ineligible / fails.
 */
export function convertToToon(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length < MIN_TOON_SIZE || trimmed.length > MAX_TOON_SIZE) return null;

  // Quick check: must start with [ or {
  const firstChar = trimmed[0];
  if (firstChar !== "[" && firstChar !== "{") return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isEligibleData(parsed)) return null;

  try {
    const encoded = encode(parsed);
    // Safety check: must be non-empty and strictly smaller than original text
    if (encoded && typeof encoded === "string" && encoded.length > 0 && encoded.length < text.length) {
      return encoded;
    }
  } catch {
    return null;
  }

  return null;
}

function compressText(text, stats, shape) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  const compressed = convertToToon(text);
  if (!compressed) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  const bytesOut = compressed.length;
  stats.bytesAfter += bytesOut;
  stats.hits.push({ shape, saved: bytesIn - bytesOut });
  return compressed;
}

/**
 * Walks messages and compresses eligible tool results with TOON in-place.
 */
export function compressToonMessages(body, enabled) {
  if (!enabled || !body) return null;

  // Kiro format
  if (body.conversationState) {
    return compressKiroFormat(body);
  }

  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };

  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level function_call_output
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "openai-responses-string");
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "openai-responses-array");
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role: "tool", content: "..." }
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressText(msg.content, stats, "openai-tool");
        continue;
      }

      // Shape 1b: OpenAI tool message — { role: "tool", content: [{ type: "text", text: "..." }] }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-array");
          }
        }
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 2/3: Claude format blocks with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (block.is_error === true) continue; // preserve error traces

        if (typeof block.content === "string") {
          block.content = compressText(block.content, stats, "claude-string");
        } else if (Array.isArray(block.content)) {
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "claude-array");
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[TOON] compressToonMessages error:", e.message);
    return null;
  }

  return stats;
}

function compressKiroFormat(body) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error") continue;
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "kiro-tool-result");
          }
        }
      }
    }
  } catch (e) {
    console.warn("[TOON] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

export function formatToonLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  return `[TOON] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) hits=${stats.hits.length}`;
}
