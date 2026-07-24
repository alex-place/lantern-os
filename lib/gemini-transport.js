// gemini-transport.js — choose the wire for Gemini calls.
//
//   AI Studio  (generativelanguage.googleapis.com, ?key=API_KEY)  — free-tier here,
//              429s at 20 req/day/model, does NOT draw Google Cloud credits.
//   Vertex AI  (LOCATION-aiplatform.googleapis.com, Bearer ADC token)  — bills to the
//              Cloud project, so it SPENDS the Cloud credits. (#1232)
//
// Enable Vertex with GEMINI_USE_VERTEX=1 (or just set VERTEX_PROJECT). Auth uses
// Application Default Credentials (ADC): `gcloud auth application-default login`, or a
// service-account key via GOOGLE_APPLICATION_CREDENTIALS. Token cached ~50 min.
let _GoogleAuth = null;
let _auth = null;
let _tok = { value: null, exp: 0 };

function useVertex() {
  return process.env.GEMINI_USE_VERTEX === "1" || !!process.env.VERTEX_PROJECT;
}
function vertexLocation() { return process.env.VERTEX_LOCATION || "us-central1"; }
function vertexProject() { return process.env.VERTEX_PROJECT || ""; }

async function vertexAccessToken() {
  if (_tok.value && Date.now() < _tok.exp) return _tok.value;
  if (!_GoogleAuth) ({ GoogleAuth: _GoogleAuth } = require("google-auth-library"));
  if (!_auth) _auth = new _GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await _auth.getClient();
  const t = await client.getAccessToken();
  const token = typeof t === "string" ? t : (t && t.token);
  if (!token) throw new Error("vertex_no_adc_token (run: gcloud auth application-default login)");
  _tok = { value: token, exp: Date.now() + 50 * 60 * 1000 };
  return token;
}

/**
 * Resolve { hostname, path, headers } for a Gemini REST call on the active wire.
 * @param {string} model   e.g. "gemini-2.5-flash"
 * @param {string} method  "streamGenerateContent" | "generateContent"
 * @param {boolean} streaming  append ?alt=sse
 * @param {string} [apiKey]  AI-Studio key (defaults to env); ignored on Vertex
 */
async function geminiTransport({ model, method = "streamGenerateContent", streaming = true, apiKey } = {}) {
  if (useVertex()) {
    const project = vertexProject();
    if (!project) throw new Error("vertex_no_project (set VERTEX_PROJECT)");
    const loc = vertexLocation();
    const token = await vertexAccessToken();
    return {
      hostname: `${loc}-aiplatform.googleapis.com`,
      path: `/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}:${method}${streaming ? "?alt=sse" : ""}`,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      vertex: true,
    };
  }
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  const params = [];
  if (streaming) params.push("alt=sse");
  params.push(`key=${key}`);
  return {
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/${model}:${method}?${params.join("&")}`,
    headers: { "Content-Type": "application/json" },
    vertex: false,
  };
}

module.exports = { geminiTransport, useVertex, vertexAccessToken, vertexProject, vertexLocation };
