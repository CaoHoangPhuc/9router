// TOON (Token-Oriented Object Notation) Token Saver
// Losslessly converts uniform tabular/array JSON data inside tool_results
// into compact TOON tables, saving 30-60% tokens without affecting model reasoning.

import { encode } from "@toon-format/toon";

export const MIN_TOON_SIZE = 150;      // Skip tiny strings (< 150 chars)
export const MAX_TOON_SIZE = 500000;   // Skip huge files to protect memory

// Comprehensive guard against configs, errors, diagnostics, diffs, or code ASTs
const FORBIDDEN_KEYS = new Set([
  // Errors & Diagnostics
  "error", "errors", "exception", "errno", "syscall", "stack", "trace", "stderr", "callsite", "fatal",
  // Package & Project manifests
  "dependencies", "devDependencies", "peerDependencies", "optionalDependencies",
  "scripts", "compilerOptions", "repository", "engines", "eslintConfig",
  "keywords", "publishConfig", "husky", "browserslist", "exports", "imports",
  // Code & Patch structures
  "hunks", "diff", "patch", "ast", "tokens", "sourceCode", "codeSnippet"
]);

export function hasForbiddenKeys(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (hasForbiddenKeys(obj[i])) return true;
    }
    return false;
  }
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    const val = obj[key];
    if (val && typeof val === "object" && hasForbiddenKeys(val)) return true;
  }
  return false;
}

/**
 * Checks whether an array consists of 100% uniform objects suitable for tabular TOON formatting.
 */
export function isArrayOfUniformObjects(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return false;

  // 100% of items must be non-null plain objects
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
  }

  // Check first item keys
  const firstKeys = Object.keys(arr[0]);
  if (firstKeys.length < 2) return false; // Needs at least 2 columns to be a meaningful table

  for (const k of firstKeys) {
    if (FORBIDDEN_KEYS.has(k)) return false;
  }

  const firstKeySorted = [...firstKeys].sort().join(",");

  // Stricter Uniformity: All rows must share the exact same column schema
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const keys = Object.keys(item);
    if (keys.length !== firstKeys.length) return false;
    if ([...keys].sort().join(",") !== firstKeySorted) return false;
    if (hasForbiddenKeys(item)) return false;
  }

  return true;
}

/**
 * Verifies whether the parsed JSON data is safe and beneficial for TOON encoding.
 */
export function isEligibleData(parsed) {
  if (!parsed || typeof parsed !== "object") return false;

  // Check entire structure for forbidden error/config/code keys
  if (hasForbiddenKeys(parsed)) return false;

  if (Array.isArray(parsed)) {
    return isArrayOfUniformObjects(parsed);
  }

  // Top-level object wrapping an array of uniform objects (e.g., { total: 10, rows: [...] })
  const topKeys = Object.keys(parsed);
  if (topKeys.length > 5) return false;

  // Status check: if object has a "status" field, it must not indicate an error
  if (parsed.status && typeof parsed.status === "string") {
    const s = parsed.status.toLowerCase();
    if (s === "error" || s === "failed" || s === "failure") return false;
  }

  let hasUniformArray = false;
  for (const k of topKeys) {
    const val = parsed[k];
    if (Array.isArray(val) && isArrayOfUniformObjects(val)) {
      hasUniformArray = true;
    }
  }

  return hasUniformArray;
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

function tryCompressText(text, shape) {
  const bytesIn = text.length;
  const compressed = convertToToon(text);
  if (!compressed) return null;

  const bytesOut = compressed.length;
  return {
    compressed,
    bytesIn,
    bytesOut,
    shape,
    saved: bytesIn - bytesOut
  };
}

/**
 * Walks messages and compresses eligible tool results with TOON.
 * Uses transactional staging: no mutations occur unless the full pass completes safely.
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

  const stagedEdits = [];
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };

  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level function_call_output or custom_tool_call_output
      if (msg.type === "function_call_output" || msg.type === "custom_tool_call_output") {
        if (typeof msg.output === "string") {
          const res = tryCompressText(msg.output, "openai-responses-string");
          if (res) {
            stagedEdits.push(() => { msg.output = res.compressed; });
            stats.bytesBefore += res.bytesIn;
            stats.bytesAfter += res.bytesOut;
            stats.hits.push({ shape: res.shape, saved: res.saved });
          }
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && (part.type === "input_text" || part.type === "text") && typeof part.text === "string") {
              const res = tryCompressText(part.text, "openai-responses-array");
              if (res) {
                stagedEdits.push(() => { part.text = res.compressed; });
                stats.bytesBefore += res.bytesIn;
                stats.bytesAfter += res.bytesOut;
                stats.hits.push({ shape: res.shape, saved: res.saved });
              }
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role: "tool", content: "..." }
      if (msg.role === "tool" && typeof msg.content === "string") {
        const res = tryCompressText(msg.content, "openai-tool");
        if (res) {
          stagedEdits.push(() => { msg.content = res.compressed; });
          stats.bytesBefore += res.bytesIn;
          stats.bytesAfter += res.bytesOut;
          stats.hits.push({ shape: res.shape, saved: res.saved });
        }
        continue;
      }

      // Shape 1b: OpenAI tool message — { role: "tool", content: [{ type: "text", text: "..." }] }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            const res = tryCompressText(part.text, "openai-tool-array");
            if (res) {
              stagedEdits.push(() => { part.text = res.compressed; });
              stats.bytesBefore += res.bytesIn;
              stats.bytesAfter += res.bytesOut;
              stats.hits.push({ shape: res.shape, saved: res.saved });
            }
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
          const res = tryCompressText(block.content, "claude-string");
          if (res) {
            stagedEdits.push(() => { block.content = res.compressed; });
            stats.bytesBefore += res.bytesIn;
            stats.bytesAfter += res.bytesOut;
            stats.hits.push({ shape: res.shape, saved: res.saved });
          }
        } else if (Array.isArray(block.content)) {
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              const res = tryCompressText(part.text, "claude-array");
              if (res) {
                stagedEdits.push(() => { part.text = res.compressed; });
                stats.bytesBefore += res.bytesIn;
                stats.bytesAfter += res.bytesOut;
                stats.hits.push({ shape: res.shape, saved: res.saved });
              }
            }
          }
        }
      }
    }

    // Atomically commit staged edits only if full walk succeeded
    for (let e = 0; e < stagedEdits.length; e++) {
      stagedEdits[e]();
    }
  } catch (e) {
    console.warn("[TOON] compressToonMessages error:", e.message);
    return null;
  }

  return stats.hits.length > 0 ? stats : null;
}

function compressKiroFormat(body) {
  const stagedEdits = [];
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
            const res = tryCompressText(part.text, "kiro-tool-result");
            if (res) {
              stagedEdits.push(() => { part.text = res.compressed; });
              stats.bytesBefore += res.bytesIn;
              stats.bytesAfter += res.bytesOut;
              stats.hits.push({ shape: res.shape, saved: res.saved });
            }
          }
        }
      }
    }

    for (let e = 0; e < stagedEdits.length; e++) {
      stagedEdits[e]();
    }
  } catch (e) {
    console.warn("[TOON] compressKiroFormat error:", e.message);
    return null;
  }

  return stats.hits.length > 0 ? stats : null;
}

export function formatToonLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  return `saved ${saved} chars / ${stats.bytesBefore} (${pct}%) hits=${stats.hits.length}`;
}
