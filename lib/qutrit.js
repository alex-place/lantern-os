const crypto = require("crypto");

const QUTRIT_MAP = {
  "a": { digit: "0", flavor: "low" },
  "o": { digit: "0", flavor: "mid" },
  "x": { digit: "0", flavor: "high" },
  "b": { digit: "1", flavor: "low" },
  "i": { digit: "1", flavor: "mid" },
  "y": { digit: "1", flavor: "high" },
  "c": { digit: "2", flavor: "low" },
  "z": { digit: "2", flavor: "mid" },
  "w": { digit: "2", flavor: "high" },
};

const REVERSE_MAP = {};
Object.keys(QUTRIT_MAP).forEach((char) => {
  REVERSE_MAP[char] = QUTRIT_MAP[char].digit;
});

function generateQutritId(seed) {
  const hash = crypto
    .createHash("sha256")
    .update(String(seed))
    .digest("hex");

  const buffer = Buffer.from(hash.slice(0, 20), "hex");
  let num = BigInt("0x" + buffer.toString("hex"));

  let base3 = "";
  for (let i = 0; i < 12; i++) {
    base3 = (num % 3n) + base3;
    num = num / 3n;
  }
  base3 = base3.padStart(12, "0").slice(-12);

  return base3
    .split("")
    .map((digit, index) => {
      const flavor = index % 3;
      const mapKey = ["low", "mid", "high"][flavor];
      const entry = Object.values(QUTRIT_MAP).find(
        (e) => e.digit === digit && e.flavor === mapKey
      );
      return entry
        ? Object.keys(QUTRIT_MAP).find((k) => QUTRIT_MAP[k] === entry)
        : digit;
    })
    .join("");
}

function decodeQutritId(qutritId) {
  if (typeof qutritId !== "string" || qutritId.length !== 12) {
    throw new Error("Invalid Qutrit ID: must be exactly 12 characters");
  }

  let base3 = "";
  for (const char of qutritId) {
    const digit = REVERSE_MAP[char.toLowerCase()];
    if (digit === undefined) {
      throw new Error(`Invalid character in Qutrit ID: ${char}`);
    }
    base3 += digit;
  }

  return base3;
}

function generateEntryId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = {
  QUTRIT_MAP,
  REVERSE_MAP,
  generateQutritId,
  decodeQutritId,
  generateEntryId,
};
