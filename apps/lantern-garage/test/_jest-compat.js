/**
 * test/_jest-compat.js
 *
 * The Jest API subset some suites in this folder were written against, mapped onto
 * node:test + node:assert. Jest was never a dependency here, so those suites never ran
 * (they died on "describe is not defined") and sat in .quarantine. One require line
 * brings them onto the runner CI already uses (scripts/run-garage-tests.mjs → node --test)
 * without rewriting hundreds of assertions.
 *
 *   const { describe, it, test, beforeEach, afterEach, beforeAll, afterAll, expect } =
 *     require("./_jest-compat");
 *
 * Covered: describe/it/test (+ test.each / it.each with %s %d %i %f %j %o %p %# titles),
 * beforeEach/afterEach/beforeAll/afterAll, expect(...) with .not / .resolves / .rejects,
 * expect.any(). Matchers: toBe toEqual toStrictEqual toMatch toContain toHaveLength
 * toBeDefined toBeUndefined toBeNull toBeTruthy toBeFalsy toBeGreaterThan
 * toBeGreaterThanOrEqual toBeLessThan toBeLessThanOrEqual toBeCloseTo toBeInstanceOf
 * toMatchObject toThrow. Anything else throws loudly rather than passing silently.
 */
"use strict";

const nodeTest = require("node:test");
const assert = require("node:assert");
const { inspect } = require("node:util");

const ASYM = Symbol("asymmetricMatcher");

function any(Ctor) {
  return {
    [ASYM]: true,
    match(v) {
      if (Ctor === String) return typeof v === "string" || v instanceof String;
      if (Ctor === Number) return typeof v === "number" || v instanceof Number;
      if (Ctor === Boolean) return typeof v === "boolean" || v instanceof Boolean;
      if (Ctor === Function) return typeof v === "function";
      if (Ctor === Object) return v !== null && typeof v === "object";
      return v instanceof Ctor;
    },
    toString() { return `Any<${Ctor && Ctor.name}>`; },
  };
}

// Jest's toEqual: recursive, ignores properties whose value is undefined, understands
// asymmetric matchers. `strict` (toStrictEqual) keeps undefined properties and types.
function equals(a, b, strict) {
  if (b && b[ASYM]) return b.match(a);
  if (a && a[ASYM]) return a.match(b);
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !equals(v, b.get(k), strict)) return false;
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (![...b].some((w) => equals(v, w, strict))) return false;
    return true;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => equals(v, b[i], strict));
  }
  const keys = (o) => Object.keys(o).filter((k) => strict || o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  if (ka.length !== kb.length) return false;
  return kb.every((k) => Object.prototype.hasOwnProperty.call(a, k) && equals(a[k], b[k], strict));
}

function matchesObject(actual, expected) {
  if (expected && expected[ASYM]) return expected.match(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((v, i) => matchesObject(actual[i], v));
  }
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date) && !(expected instanceof RegExp)) {
    if (actual === null || typeof actual !== "object") return false;
    return Object.keys(expected).every((k) => k in Object(actual) && matchesObject(actual[k], expected[k]));
  }
  return equals(actual, expected, false);
}

function show(v) { return inspect(v, { depth: 6, breakLength: 120 }); }

function thrownBy(fn) {
  try { fn(); } catch (e) { return { threw: true, error: e }; }
  return { threw: false };
}

function errorMatches(error, expected) {
  if (expected === undefined) return true;
  const msg = error && error.message !== undefined ? String(error.message) : String(error);
  if (typeof expected === "string") return msg.includes(expected);
  if (expected instanceof RegExp) return expected.test(msg);
  if (typeof expected === "function") return error instanceof expected;
  if (expected instanceof Error) return msg === expected.message;
  return false;
}

const MATCHERS = {
  toBe: (a, e) => [Object.is(a, e), `expected ${show(a)} to be ${show(e)}`],
  toEqual: (a, e) => [equals(a, e, false), `expected ${show(a)} to equal ${show(e)}`],
  toStrictEqual: (a, e) => [equals(a, e, true), `expected ${show(a)} to strictly equal ${show(e)}`],
  toMatch: (a, e) => [typeof a === "string" && (e instanceof RegExp ? e.test(a) : a.includes(e)),
    `expected ${show(a)} to match ${show(e)}`],
  toContain: (a, e) => {
    let ok = false;
    if (typeof a === "string") ok = a.includes(e);
    else if (a != null && typeof a[Symbol.iterator] === "function") ok = [...a].some((v) => v === e);
    return [ok, `expected ${show(a)} to contain ${show(e)}`];
  },
  toHaveLength: (a, n) => [a != null && a.length === n, `expected length ${n}, got ${a == null ? a : a.length}`],
  toBeDefined: (a) => [a !== undefined, `expected value to be defined`],
  toBeUndefined: (a) => [a === undefined, `expected ${show(a)} to be undefined`],
  toBeNull: (a) => [a === null, `expected ${show(a)} to be null`],
  toBeTruthy: (a) => [Boolean(a), `expected ${show(a)} to be truthy`],
  toBeFalsy: (a) => [!a, `expected ${show(a)} to be falsy`],
  toBeGreaterThan: (a, e) => [a > e, `expected ${show(a)} > ${show(e)}`],
  toBeGreaterThanOrEqual: (a, e) => [a >= e, `expected ${show(a)} >= ${show(e)}`],
  toBeLessThan: (a, e) => [a < e, `expected ${show(a)} < ${show(e)}`],
  toBeLessThanOrEqual: (a, e) => [a <= e, `expected ${show(a)} <= ${show(e)}`],
  toBeCloseTo: (a, e, digits = 2) => [Math.abs(e - a) < Math.pow(10, -digits) / 2,
    `expected ${show(a)} to be close to ${show(e)} (${digits} digits)`],
  toBeInstanceOf: (a, C) => [a instanceof C, `expected value to be an instance of ${C && C.name}`],
  toMatchObject: (a, e) => [matchesObject(a, e), `expected ${show(a)} to match object ${show(e)}`],
  toThrow: (fn, e) => {
    if (typeof fn !== "function") throw new TypeError("toThrow expects a function");
    const r = thrownBy(fn);
    return [r.threw && errorMatches(r.error, e),
      r.threw ? `expected thrown ${show(r.error && r.error.message)} to match ${show(e)}` : "expected function to throw"];
  },
};

function buildMatchers(getActual, negate, isAsync) {
  const out = {};
  for (const [name, check] of Object.entries(MATCHERS)) {
    const run = (actual, args) => {
      const [pass, msg] = check(actual, ...args);
      if (pass === negate) throw new assert.AssertionError({ message: (negate ? "NOT: " : "") + msg, operator: name });
    };
    out[name] = isAsync
      ? async (...args) => run(await getActual(), args)
      : (...args) => run(getActual(), args);
  }
  return out;
}

function expect(actual) {
  const m = buildMatchers(() => actual, false, false);
  m.not = buildMatchers(() => actual, true, false);
  const settled = (wantReject) => async () => {
    let value;
    let error;
    let rejected = false;
    try { value = await actual; } catch (e) { rejected = true; error = e; }
    if (wantReject && !rejected) throw new assert.AssertionError({ message: `expected promise to reject, it resolved to ${show(value)}` });
    if (!wantReject && rejected) throw new assert.AssertionError({ message: `expected promise to resolve, it rejected: ${show(error && error.message)}` });
    return wantReject ? error : value;
  };
  m.resolves = buildMatchers(settled(false), false, true);
  m.resolves.not = buildMatchers(settled(false), true, true);
  m.rejects = buildMatchers(settled(true), false, true);
  m.rejects.not = buildMatchers(settled(true), true, true);
  return new Proxy(m, {
    get(target, prop) {
      if (prop in target || typeof prop === "symbol") return target[prop];
      throw new Error(`_jest-compat: matcher "${String(prop)}" is not implemented — add it rather than letting it pass silently`);
    },
  });
}
expect.any = any;

function formatTitle(title, args, index) {
  let i = 0;
  return String(title).replace(/%([sdifjoOp#%])/g, (all, f) => {
    if (f === "%") return "%";
    if (f === "#") return String(index);
    const v = args[i++];
    if (f === "d" || f === "i") return String(Math.trunc(Number(v)));
    if (f === "f") return String(Number(v));
    if (f === "j") return JSON.stringify(v);
    if (f === "s") return typeof v === "string" ? v : inspect(v);
    return inspect(v, { depth: 3 });
  });
}

function withEach(fn) {
  fn.each = (table) => (title, body, timeout) => {
    table.forEach((row, index) => {
      const args = Array.isArray(row) ? row : [row];
      fn(formatTitle(title, args, index), timeout ? { timeout } : {}, () => body(...args));
    });
  };
  return fn;
}

const test = withEach((name, opts, fn) => (typeof opts === "function" ? nodeTest.test(name, opts) : nodeTest.test(name, opts, fn)));
const it = withEach((name, opts, fn) => (typeof opts === "function" ? nodeTest.it(name, opts) : nodeTest.it(name, opts, fn)));
test.skip = nodeTest.test.skip;
it.skip = nodeTest.it.skip;

module.exports = {
  describe: nodeTest.describe,
  it,
  test,
  beforeEach: nodeTest.beforeEach,
  afterEach: nodeTest.afterEach,
  beforeAll: nodeTest.before,
  afterAll: nodeTest.after,
  expect,
};
