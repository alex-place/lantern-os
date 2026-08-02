#!/usr/bin/env node
/**
 * label_doc_audience.mjs — one-time labeller that stamps an `audience` on every
 * doc-catalog entry, then leaves the field as reviewable DATA (edit the catalog,
 * not this script, to move a doc afterwards).
 *
 * Why the field exists: the Knowledge Center published everything the catalog
 * marked `keep`, so operator runbooks sat next to the FAQ on a public marketing
 * surface — including the GCE runbook that names the live origin IP, which hands
 * an attacker the address behind Cloudflare. "Should this be built?" (action) and
 * "who is this for?" (audience) are different questions and need different fields.
 *
 *   public   — a visitor to unisona.ai: what it does, how to use it, limits, privacy.
 *   builder  — someone reading or extending the codebase: architecture, ADRs,
 *              research, model/training notes. Published, but behind its own filter.
 *   internal — operator-only: infra, deploy, admin, agent process, audits, secrets
 *              handling. NEVER published to the site.
 *
 * Run: node scripts/label_doc_audience.mjs [--write]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(REPO, 'data', 'knowledge', 'doc-catalog.json');

// Operator-only. Anything naming infra, deploy topology, admin surfaces, the agent
// process, or an internal audit. Matched against the path, case-insensitively.
const INTERNAL_PATTERNS = [
  /^docs\/ops\//i,
  /^docs\/runbooks\//i,
  /gce-cloud-deploy/i,
  /cloudflare-tunnel/i,
  /media-hosting-r2/i,
  /convergence-router-deployment/i,
  /admin-feature-flags/i,
  /agent-orchestration/i,
  /monoworkstream/i,
  /dev-server-worktree/i,
  /greenpath-gate/i,
  /backlog-review-standards/i,
  /v1-readiness-gates/i,
  /test-auth/i,
  /^docs\/hooks\.md$/i,
  /pii-local-scrub/i,
  /mesh-hub/i,
  /accessibility-audit-system/i,
  /knowledge-center-audit/i,
  /python-scripts-audit/i,
  /editor_learning_audit/i,
  /innovator-evidence-method/i,
  /rollover/i,
  /sigma0-coder-devbox-setup/i,
  /sigma0-eb-l4-runbook/i,
  /weekly-training-setup/i,
  /fallout-radio-backlog/i,
  /^scripts\.md$/i,
];

// Visitor-facing product documentation.
const PUBLIC_PATHS = new Set([
  'docs/KEYSTONE-PRODUCT.md',
  'docs/KEYSTONE-LIMITATIONS.md',
  'docs/CONVERGENCE-LOOP.md',
  'docs/MEMORY-RETRIEVAL.md',
  'docs/EXPLORE-FEED.md',
  'docs/ACCESSIBILITY.md',
  'docs/PRIVACY_GOVERNANCE.md',
  'SECURITY.md',
  'SKILLS.md',
  'PROVIDERS.md',
  'docs/mcp-client-setup.md',
  'docs/MCP-CONNECTOR.md',
  'docs/KEYSTONE-MCP.md',
  'docs/CHATGPT-CONNECTOR-SETUP.md',
  'docs/CLAUDE-CHATGPT-MCP-SETUP.md',
  'docs/GOOGLE-OAUTH.md',
  'docs/PATREON-OAUTH.md',
  'docs/USER-PROFILES.md',
  'docs/DREAM-JOURNAL-QUICKSTART.md',
  'docs/PORTFOLIO-SETUP.md',
  'docs/trading-api-reference.md',
  'docs/KALSHI-API-SPEC.md',
  'docs/CHAT-EVAL-RECIPE.md',
  // Release notes and license attribution are normal things to publish.
  'CHANGELOG.MD',
  'THIRD-PARTY-NOTICES.md',
  'docs/loop/observe.md', 'docs/loop/remember.md', 'docs/loop/reason.md',
  'docs/loop/act.md', 'docs/loop/verify.md', 'docs/loop/converge.md',
]);

export function audienceFor(entry) {
  const p = entry.path;
  // ADRs are the "why" record for the codebase and are always publishable, even when
  // the decision is about internal process (0007 is about PR lanes). They document a
  // choice; they don't hand out infra detail.
  if (/^docs\/adr\//i.test(p)) return 'builder';
  if (INTERNAL_PATTERNS.some((re) => re.test(p))) return 'internal';
  if (PUBLIC_PATHS.has(p)) return 'public';
  return 'builder';
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const counts = { public: 0, builder: 0, internal: 0 };
for (const e of catalog) {
  e.audience = audienceFor(e);
  counts[e.audience]++;
}

if (process.argv.includes('--write')) {
  fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
  console.log('catalog updated');
}
console.log(counts);
const internalKeep = catalog.filter((e) => e.audience === 'internal' && e.action === 'keep');
console.log(`\nunpublished by this pass (${internalKeep.length}):`);
for (const e of internalKeep) console.log('   ', e.path);
