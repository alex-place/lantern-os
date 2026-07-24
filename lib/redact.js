// redact.js — high-confidence PII / secret redaction for data stored at rest (#770).
//
// Conservative by design: only well-known, high-precision patterns (emails, phones,
// SSN, card numbers, and common API-key/token shapes). It will occasionally over-redact
// a bare 10-digit number as a phone — that is the privacy-safe direction. Applied to
// conversation text before it is persisted so a log leak exposes far less.

// Order matters: most specific first (cards/SSN before the looser phone matcher; keys
// before the generic token shapes).
const RULES = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]"],
  [/\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted-jwt]"],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [redacted-token]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted-ssn]"],
  [/(?<!\d)(?:\d{4}[ -]){3}\d{4}(?!\d)/g, "[redacted-cc]"],
  [/(?<!\d)(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g, "[redacted-phone]"],
];

function redactPII(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [re, replacement] of RULES) {
    out = out.replace(re, replacement);
  }
  return out;
}

module.exports = { redactPII };
