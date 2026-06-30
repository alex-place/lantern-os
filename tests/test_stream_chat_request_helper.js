const assert = require("assert");
const { sanitizeHistory, parseStreamChatRequest } = require("../apps/lantern-garage/lib/stream-chat/request");

const history = sanitizeHistory([
  { role: "system", text: "ignored role becomes user" },
  { role: "assistant", text: "a".repeat(1200) },
  { role: "user", text: "hello" },
  { role: "assistant", text: "there" },
  { role: "user", text: "again" },
  { role: "assistant", text: "ok" },
  { role: "user", text: "tail" },
]);

assert.strictEqual(history.length, 6);
assert.strictEqual(history[0].role, "assistant");
assert.strictEqual(history[0].text.length, 1000);
assert.strictEqual(history[5].text, "tail");
assert.deepStrictEqual(sanitizeHistory(null), []);
assert.deepStrictEqual(sanitizeHistory([{ role: "user" }]), []);

(async () => {
  const postUrl = new URL("http://local/api/dream/chat/stream");

  // GET path
  const getUrl = new URL("http://local/api/dream/chat/stream?message=%20hello%20&user=Alex&agent=keystone&provider=OpenAI");
  const parsedGet = await parseStreamChatRequest({ method: "GET" }, getUrl, {
    normalizeDreamerUser: (value) => String(value).toLowerCase(),
  });
  assert.strictEqual(parsedGet.message, "hello");
  assert.strictEqual(parsedGet.user, "alex");
  assert.strictEqual(parsedGet.requestedAgent, "keystone");
  assert.strictEqual(parsedGet.requestedProvider, "openai");
  assert.deepStrictEqual(parsedGet.history, []);
  assert.strictEqual(parsedGet.mcpFlag, false);
  assert.strictEqual(parsedGet.parseError, undefined);

  // Normal POST
  const parsedPost = await parseStreamChatRequest({ method: "POST" }, postUrl, {
    normalizeDreamerUser: (value) => `u:${value}`,
    collectRequestBody: async () => JSON.stringify({
      message: "  hi  ",
      user: "dreamer-one",
      agent: "lantern",
      provider: "Gemini",
      mcp: true,
      history: [{ role: "assistant", text: "previous" }],
    }),
  });
  assert.strictEqual(parsedPost.message, "hi");
  assert.strictEqual(parsedPost.user, "u:dreamer-one");
  assert.strictEqual(parsedPost.requestedAgent, "lantern");
  assert.strictEqual(parsedPost.requestedProvider, "gemini");
  assert.strictEqual(parsedPost.mcpFlag, true);
  assert.deepStrictEqual(parsedPost.history, [{ role: "assistant", text: "previous" }]);
  assert.strictEqual(parsedPost.parseError, undefined);

  // Malformed JSON → parseError not silent swallow (#1009)
  const malformed = await parseStreamChatRequest({ method: "POST" }, postUrl, {
    collectRequestBody: async () => "not-json",
  });
  assert.strictEqual(malformed.parseError, "malformed_json");
  assert.strictEqual(malformed.message, "");
  assert.strictEqual(malformed.user, "dreamer");
  assert.deepStrictEqual(malformed.history, []);

  // UTF-8 BOM prefix → strips cleanly, parses fine (#1009)
  const BOM = "﻿";
  const bomPrefixed = await parseStreamChatRequest({ method: "POST" }, postUrl, {
    collectRequestBody: async () => BOM + JSON.stringify({ message: "bom test", user: "alice" }),
  });
  assert.strictEqual(bomPrefixed.parseError, undefined);
  assert.strictEqual(bomPrefixed.message, "bom test");
  assert.strictEqual(bomPrefixed.user, "alice");

  // Empty body → parseError "empty_body" (#1009)
  const emptyBody = await parseStreamChatRequest({ method: "POST" }, postUrl, {
    collectRequestBody: async () => "",
  });
  assert.strictEqual(emptyBody.parseError, "empty_body");

  // Whitespace-only body → parseError "empty_body" (#1009)
  const whitespaceBody = await parseStreamChatRequest({ method: "POST" }, postUrl, {
    collectRequestBody: async () => "   \n  ",
  });
  assert.strictEqual(whitespaceBody.parseError, "empty_body");

  // Image attachments survive sanitization (#1606): an uploaded image carries a data URL
  // and NO text. It must be kept (so the server can resolve it via vision) — previously it
  // was filtered out and the model reported it received "0 files".
  const withImage = await parseStreamChatRequest({ method: "POST" }, postUrl, {
    collectRequestBody: async () => JSON.stringify({
      message: "what is this?",
      user: "alex",
      attachments: [
        { name: "photo.png", image: "data:image/png;base64,iVBORw0KAA==", mimeType: "image/png" },
        { name: "notes.txt", text: "hello world" },
        { name: "empty.png", image: "   " },     // blank image → dropped
        { name: "nothing.bin" },                 // neither text nor image → dropped
      ],
    }),
  });
  assert.strictEqual(withImage.attachments.length, 2);
  const img = withImage.attachments.find((a) => a.name === "photo.png");
  assert.ok(img, "image attachment kept");
  assert.strictEqual(img.image, "data:image/png;base64,iVBORw0KAA==");
  assert.strictEqual(img.mimeType, "image/png");
  assert.strictEqual(img.text, undefined);
  const txt = withImage.attachments.find((a) => a.name === "notes.txt");
  assert.ok(txt && txt.text === "hello world", "text attachment kept");
  assert.strictEqual(txt.image, undefined);

  console.log("stream-chat request helper tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
