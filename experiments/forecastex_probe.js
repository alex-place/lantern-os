#!/usr/bin/env node
"use strict";

/**
 * ForecastEx read-only probe (#2216) — de-risk the weather-oracle port before any order
 * code exists. This script is STRICTLY READ-ONLY: it calls /tickle, /portfolio/*,
 * /iserver/secdef/search and /iserver/marketdata/snapshot only. It NEVER calls placeOrder
 * or any /orders endpoint. Its job is to answer, from a live authenticated session, the
 * four questions that gate the port (issue #2216):
 *
 *   1. Does IBKR CPAPI list ForecastEx contracts via /iserver/secdef/search, and what
 *      secType / conid shape comes back?
 *   2. What is the fill depth at the ~1¢ spread for NYC daily-high buckets?
 *   3. Does the account carry ForecastEx / prediction-market trading permission?
 *   4. Do ForecastEx strikes line up with the oracle's bucket ladder, or need remapping?
 *
 * Usage:
 *   IBKR_PROBE_USER=<userId> node experiments/forecastex_probe.js [symbol ...]
 *
 * With no symbols, a candidate list of likely ForecastEx NYC-high identifiers is tried.
 * The exact ForecastEx symbol is unknown until this runs — that discovery IS the probe.
 * A JSON findings note is written to data/kalshi/forecastex-probe-<ts>.json and a human
 * summary is printed. If credentials aren't connected the script explains how and exits 0
 * (a probe that can't reach IBKR is an inconclusive finding, not a crash).
 */

const fs = require("fs");
const path = require("path");

const store = require("../apps/lantern-garage/lib/ibkr-credentials");
const IbkrCpapi = require("../apps/lantern-garage/lib/ibkr-cpapi");

const OUT_DIR = path.resolve(__dirname, "../data/kalshi");

// ForecastEx lists by ECONOMIC NAME (not short ticker) and only surfaces with name:true.
// Matches carry exchange FORECASTX and secType IND (underlying) / EC (tradeable Event
// Contract). Live probe 2026-07-08 confirmed: NYC daily high = symbol UHLGA, conid
// 853400786; econ underlyings CPI/Unemployment/GDP/Fed Funds also list. Search these name
// phrases; override on the command line. (The old ticker guesses — KNYC/HIGHNY — never
// resolved: the underlying is "New York City Daily Temperature High".)
const DEFAULT_CANDIDATES = [
  "New York City Daily Temperature High", "Chicago", "Denver", "Miami",
  "Consumer Price Index", "Unemployment", "GDP", "Fed Funds",
];
const FORECASTX = "FORECASTX";
const isForecastX = (m) => JSON.stringify(m || {}).includes(FORECASTX);

// The oracle's NYC-high bucket ladder (the shape production is calibrated to). Used only to
// show ForecastEx strikes side-by-side with what the oracle expects — no trading logic.
const ORACLE_LADDER = [
  "<=91", "92-93", "94-95", "96-97", "98-99", ">=100",
];

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const argv = process.argv.slice(2);
  const symbols = argv.length ? argv : DEFAULT_CANDIDATES;
  const userId = process.env.IBKR_PROBE_USER || process.env.IBKR_ACCOUNT_USER || "";

  const findings = {
    probe: "forecastex-read-only",
    issue: 2216,
    at: new Date().toISOString(),
    userId: userId || "(default)",
    connected: false,
    authenticated: false,
    accountId: null,
    permissionSignals: {},
    searched: [],
    resolved: [],
    depth: [],
    ladderComparison: { oracle: ORACLE_LADDER, forecastex: null, aligned: null },
    notes: [],
  };

  const signer = userId ? store.buildSigner(userId) : store.buildSigner();
  if (!signer) {
    findings.notes.push(
      "No stored IBKR credentials for this user. Connect via the trader UI (IBKR OAuth) " +
      "first, then re-run with IBKR_PROBE_USER=<userId>. Probe inconclusive.");
    return finish(findings);
  }

  // 15 s: the EC contract-detail endpoints answer slowly (a real 503 for an unentitled
  // account can take >6 s); the default 6 s timeout would mask it as a bare timeout.
  const client = new IbkrCpapi({ oauth1: signer, timeoutMs: 15000 });

  // 0. Auth — read-only session is enough for secdef/search + snapshot.
  const p = await client.probe().catch((e) => ({ error: e.message }));
  findings.connected = !!(p && p.connected);
  findings.authenticated = !!(p && p.authenticated);
  if (!findings.authenticated) {
    findings.notes.push(
      "IBKR handshake did not authenticate" +
      (client._lstError ? ` (reason: ${client._lstError.code})` : "") +
      ". If the consumer is newly registered, activation can lag up to ~24h. Probe inconclusive.");
    return finish(findings);
  }

  findings.accountId = await client.resolveAccountId().catch(() => null);

  // 3. Permission signals — the account summary / accounts payload sometimes surfaces
  //    tradeable asset classes or a ForecastEx/event flag. We record raw hints; a
  //    definitive answer may still require checking the IBKR account's trading permissions
  //    page. No order is attempted to "test" permission.
  try {
    const accounts = await client.getAccounts();
    const summary = findings.accountId ? await client.getAccountSummary(findings.accountId) : null;
    const hay = JSON.stringify({ accounts, summary }).toLowerCase();
    // tradingType is the decisive entitlement signal: "STKNOPT" = Stocks+Options only, i.e.
    // NO ForecastEx event contracts (live probe 2026-07-08). An EC-entitled account shows a
    // tradingType that includes event/EC access.
    const acct = (Array.isArray(accounts) ? accounts : []).find((a) => a && (a.accountId === findings.accountId || a.id === findings.accountId)) || (accounts || [])[0] || {};
    const tradingType = acct.tradingType || null;
    findings.permissionSignals = {
      accountsListed: Array.isArray(accounts) ? accounts.length : 0,
      tradingType,
      stkOptOnly: tradingType === "STKNOPT",
      mentionsForecastEx: hay.includes("forecast"),
      mentionsPrediction: hay.includes("prediction") || hay.includes("event"),
      raw: { accounts: accounts || null },
    };
    if (tradingType === "STKNOPT") {
      findings.notes.push(
        `Account ${findings.accountId} tradingType=STKNOPT (Stocks+Options only) — NOT entitled ` +
        "to ForecastEx event contracts. The EC ladder + market data will 503; a " +
        "ForecastEx-permissioned account is required to enumerate buckets/depth.");
    }
  } catch (e) {
    findings.notes.push(`Account permission probe failed: ${e.message}`);
  }

  // 1. Contract discovery — search each candidate with name:true (ForecastEx underlyings
  //    only surface by economic name), keep the FORECASTX matches, record their shape.
  for (const sym of symbols) {
    const r = await client._request("POST", "/iserver/secdef/search", { symbol: sym, name: true })
      .catch((e) => ({ ok: false, error: e.message }));
    const all = r && r.ok && Array.isArray(r.json) ? r.json : [];
    const matches = all.filter(isForecastX);
    findings.searched.push({ symbol: sym, matchCount: all.length, forecastxCount: matches.length, ok: !!(r && r.ok) });
    for (const m of matches) {
      findings.resolved.push({
        symbol: m.symbol || sym,
        query: sym,
        conid: m.conid ?? m.conidex ?? null,
        secType: m.secType || (Array.isArray(m.sections) && m.sections[0] && m.sections[0].secType) || null,
        sections: Array.isArray(m.sections) ? m.sections.map((s) => s.secType) : null,
        description: m.companyHeader || m.companyName || m.description || null,
        likelyForecastEx: true,
      });
    }
  }

  // 1b. For each FORECASTX underlying, resolve the tradeable Event-Contract (EC) shape via
  //     secdef/info. The daily temperature buckets are secType EC (not OPT); record the
  //     status so a failure to enumerate the ladder is a visible finding, not a silent gap.
  for (const rec of findings.resolved.filter((r) => r.conid).slice(0, 12)) {
    const info = await client._request("GET", `/iserver/contract/${encodeURIComponent(rec.conid)}/info`)
      .catch((e) => ({ ok: false, error: e.message }));
    if (info && info.ok && info.json) {
      rec.instrumentType = info.json.instrument_type || null;
      rec.hasRelatedContracts = info.json.has_related_contracts ?? null;
      rec.validExchanges = info.json.valid_exchanges || null;
    }
  }

  // 1c. EC-ladder entitlement probe on the first resolved underlying. A 503 here (with a
  //     STKNOPT account) is the definitive "not entitled" signal — no month string fixes it.
  //     On a ForecastEx-permissioned account this returns the bucket ladder instead.
  const ladderTarget = findings.resolved.find((r) => r.conid);
  if (ladderTarget) {
    const months = (process.env.FORECASTEX_EC_MONTH ? [process.env.FORECASTEX_EC_MONTH] : ["JUL26", "AUG26"]);
    findings.ecLadder = { conid: ladderTarget.conid, attempts: [], entitled: null };
    for (const mo of months) {
      const r = await client._request("GET",
        `/iserver/secdef/info?conid=${encodeURIComponent(ladderTarget.conid)}&secType=EC&month=${encodeURIComponent(mo)}`)
        .catch((e) => ({ status: 0, error: e.message }));
      findings.ecLadder.attempts.push({ month: mo, status: r.status, error: r.error || null,
        buckets: Array.isArray(r.json) ? r.json.length : null });
      if (r.status === 200 && r.json) { findings.ecLadder.entitled = true; findings.ecLadder.data = r.json; break; }
      if (r.status === 503) findings.ecLadder.entitled = false;
    }
    if (findings.ecLadder.entitled === false) {
      findings.notes.push(
        "EC ladder endpoint returns 503 — ForecastEx contract details/market-data are not " +
        "served to this account. Ladder + per-bucket depth require a ForecastEx-entitled account.");
    }
  }

  if (!findings.resolved.length) {
    findings.notes.push(
      "No contracts resolved for any candidate symbol. Either ForecastEx isn't exposed via " +
      "/iserver/secdef/search for this account, or the symbol differs — try the exact ticker " +
      "from the IBKR ForecastEx market list as an argument. Depth + ladder steps skipped.");
    return finish(findings);
  }

  // 2. Fill depth — snapshot bid/ask/size for the resolved conids that look like ForecastEx
  //    weather contracts (fall back to all resolved if none flagged). Fields: 84=bid,
  //    86=ask, 88=bid size, 85=ask size (IBKR CPAPI market-data field ids).
  const depthTargets = (findings.resolved.filter((r) => r.likelyForecastEx).length
    ? findings.resolved.filter((r) => r.likelyForecastEx)
    : findings.resolved
  ).filter((r) => r.conid).slice(0, 25);
  const conids = depthTargets.map((r) => r.conid).join(",");
  if (conids) {
    const snap = await client._request(
      "GET", `/iserver/marketdata/snapshot?conids=${encodeURIComponent(conids)}&fields=84,86,88,85`)
      .catch((e) => ({ ok: false, error: e.message }));
    const rows = snap && snap.ok && Array.isArray(snap.json) ? snap.json : [];
    for (const row of rows) {
      findings.depth.push({
        conid: row.conid,
        bid: row["84"] ?? null,
        ask: row["86"] ?? null,
        bidSize: row["88"] ?? null,
        askSize: row["85"] ?? null,
      });
    }
    if (!rows.length) {
      findings.notes.push(
        "Snapshot returned no rows — IBKR often needs a second snapshot call to warm the " +
        "subscription; re-run to get live depth. Cannot assess ~1¢ fill depth yet.");
    }
  }

  // 4. Ladder alignment — surface the ForecastEx strike descriptions so a human can see
  //    whether they map 1:1 onto the oracle ladder or need remapping. We don't auto-decide.
  findings.ladderComparison.forecastex = findings.resolved
    .filter((r) => r.likelyForecastEx)
    .map((r) => r.description)
    .filter(Boolean);
  findings.notes.push(
    "Ladder alignment is a human call from the strike descriptions above vs ORACLE_LADDER " +
    "(" + ORACLE_LADDER.join(", ") + "). If ForecastEx uses different bucket edges, the port " +
    "needs a bucket→conid remap, not just a fee swap.");

  return finish(findings);
}

function finish(findings) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `forecastex-probe-${nowStamp()}.json`);
    fs.writeFileSync(file, JSON.stringify(findings, null, 2));
    findings._savedTo = file;
  } catch (e) {
    findings._saveError = e.message;
  }

  // Human summary.
  const L = [];
  L.push("── ForecastEx read-only probe (#2216) ──");
  L.push(`auth: connected=${findings.connected} authenticated=${findings.authenticated} account=${findings.accountId || "?"}`);
  L.push(`permission signals: ${JSON.stringify(findings.permissionSignals?.mentionsForecastEx ?? false)} forecastex-mention` +
    ` (accountsListed=${findings.permissionSignals?.accountsListed ?? 0})`);
  L.push(`searched ${findings.searched.length} symbols → ${findings.resolved.length} contracts resolved` +
    ` (${findings.resolved.filter((r) => r.likelyForecastEx).length} look like ForecastEx)`);
  for (const r of findings.resolved.slice(0, 15)) {
    L.push(`  • ${r.symbol}: conid=${r.conid} secType=${r.secType} exch=${r.exchange} — ${r.description || ""}` +
      (r.likelyForecastEx ? "  [ForecastEx?]" : ""));
  }
  if (findings.depth.length) {
    L.push("depth (bid/ask × size):");
    for (const d of findings.depth.slice(0, 15)) {
      L.push(`  • conid=${d.conid}: ${d.bid}/${d.ask}  size ${d.bidSize}/${d.askSize}`);
    }
  }
  if (findings.notes.length) {
    L.push("notes:");
    for (const n of findings.notes) L.push(`  - ${n}`);
  }
  if (findings._savedTo) L.push(`findings JSON: ${findings._savedTo}`);
  process.stdout.write(L.join("\n") + "\n");
  return findings;
}

main().catch((e) => {
  process.stderr.write(`forecastex probe crashed: ${e.stack || e.message}\n`);
  process.exit(1);
});
