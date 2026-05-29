const http = require("http");
const fs = require("fs");
const path = require("path");

const base = `http://127.0.0.1:${process.env.LANTERN_GARAGE_PORT || 4177}`;
const repoRoot = path.resolve(__dirname, "..", "..");
const validationPath = path.join(repoRoot, "manifests", "validation", "LANTERN-GARAGE-APP-LATEST.json");
const checks = [
  ["/api/health", (x) => x.ok === true],
  ["/api/status", (x) => x.app === "Lantern Garage" && Boolean(x.arc) && Boolean(x.wallet)],
  ["/api/arc-reactor", (x) => typeof x.movie1GarageConfidence === "number"],
  ["/api/wallet", (x) => Boolean(x.wallet) && Array.isArray(x.ledger)],
  ["/api/readiness", (x) => typeof x.readyForPrep === "boolean"],
  ["/api/mining-lab", (x) => x.ready === true && x.shortcutRule === "single_lantern_shortcut"],
  ["/api/cloud-mirrors", (x) => x.deployProvider === "Render" && x.cloudMirrorCount >= 2],
  ["/api/access-model", (x) => x.audienceTarget === "dozens_of_users" && Array.isArray(x.tiers) && x.tiers.some((tier) => tier.id === "founder" && tier.founderOnly === true)],
  ["/api/rag-cache", (x) => Array.isArray(x)],
];

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function getText(path) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data, headers: res.headers }));
    }).on("error", reject);
  });
}

(async () => {
  const results = [];
  for (const [path, predicate] of checks) {
    const result = await getJson(path);
    const ok = result.statusCode === 200 && Boolean(predicate(result.body));
    results.push({ path, ok, statusCode: result.statusCode });
    if (!ok) {
      console.error(JSON.stringify(results, null, 2));
      process.exit(1);
    }
  }
  const reader = await getText("/view?path=README.md");
  const readerOk = reader.statusCode === 200
    && /^text\/html/.test(reader.headers["content-type"] || "")
    && reader.body.includes("Lantern Reader")
    && reader.body.includes("Brand Guidelines");
  results.push({ path: "/view?path=README.md", ok: readerOk, statusCode: reader.statusCode });
  if (!readerOk) {
    console.error(JSON.stringify(results, null, 2));
    process.exit(1);
  }
  const report = { generatedAt: new Date().toISOString(), ok: true, base, results };
  fs.mkdirSync(path.dirname(validationPath), { recursive: true });
  fs.writeFileSync(validationPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
