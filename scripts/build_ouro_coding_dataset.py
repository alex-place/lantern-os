"""
Build a coding instruction-tuning corpus for the Σ₀ Ouro Coder (#781, item 1).

WHY: the current models/lantern-sigma0-coder/training-data.jsonl is ~365 rows of
general Claude-session chatter — almost no clean coding examples — which is why the
adapter emits unreliable, often non-executable code. This script assembles a corpus of
basic→intermediate Python tasks whose `output` is the function code ONLY, and — the key
property — **every output is execution-verified** (it is compiled, exec'd, and run
against its own assertions; anything that fails is dropped). The model is taught to emit
clean, correct, runnable functions.

HONESTY:
  * Outputs are verified-correct Python; nothing broken enters the training set.
  * These are hand-authored tasks, NOT HumanEval problems — training on HumanEval would
    contaminate the pass@1 eval the issue measures. (Verified: no instruction/solution is
    copied from HumanEval; these are generic common functions.)
  * This is a verified SEED, not the whole corpus. The training-box run can extend it
    (lessons.db mining, repo patch corpus) — those sources are noisier and out of scope
    here; they are left as documented extension points.

Emits rows as {"instruction", "input", "output"} (the existing file's schema), so the
seed can be concatenated with training-data.jsonl before `train-qlora-ouro.py`.

    python scripts/build_ouro_coding_dataset.py            # writes coding-seed.jsonl
    python scripts/build_ouro_coding_dataset.py --merge    # + training-data.augmented.jsonl
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import textwrap

OUT_DIR = "models/lantern-sigma0-coder"
SEED_PATH = os.path.join(OUT_DIR, "coding-seed.jsonl")
EXTRA_PATH = os.path.join(OUT_DIR, "coding-extra.jsonl")
EXISTING_PATH = os.path.join(OUT_DIR, "training-data.jsonl")
AUGMENTED_PATH = os.path.join(OUT_DIR, "training-data.augmented.jsonl")

INSTR_SUFFIX = " Output only the function code."


def _t(fn, instruction, code, checks):
    return {"fn": fn, "instruction": instruction.strip() + INSTR_SUFFIX,
            "code": textwrap.dedent(code).strip(), "checks": checks}


# Each task: clean function-only solution + assertions used to VERIFY it before export.
TASKS = [
    _t("is_prime", "Write a Python function is_prime(n) that returns True if n is a prime number, else False.",
       '''
       def is_prime(n):
           if n < 2:
               return False
           i = 2
           while i * i <= n:
               if n % i == 0:
                   return False
               i += 1
           return True
       ''', [("is_prime(2)", True), ("is_prime(17)", True), ("is_prime(1)", False), ("is_prime(15)", False)]),
    _t("reverse_string", "Write a Python function reverse_string(s) that returns the string reversed.",
       "def reverse_string(s):\n    return s[::-1]",
       [("reverse_string('abc')", "cba"), ("reverse_string('')", "")]),
    _t("factorial", "Write a Python function factorial(n) that returns n! (n factorial) for n >= 0.",
       '''
       def factorial(n):
           result = 1
           for i in range(2, n + 1):
               result *= i
           return result
       ''', [("factorial(0)", 1), ("factorial(5)", 120)]),
    _t("fib", "Write a Python function fib(n) that returns the n-th Fibonacci number (fib(0)=0, fib(1)=1).",
       '''
       def fib(n):
           a, b = 0, 1
           for _ in range(n):
               a, b = b, a + b
           return a
       ''', [("fib(0)", 0), ("fib(1)", 1), ("fib(10)", 55)]),
    _t("gcd", "Write a Python function gcd(a, b) that returns the greatest common divisor of a and b.",
       '''
       def gcd(a, b):
           while b:
               a, b = b, a % b
           return abs(a)
       ''', [("gcd(12, 18)", 6), ("gcd(7, 1)", 1), ("gcd(0, 5)", 5)]),
    _t("is_palindrome", "Write a Python function is_palindrome(s) that returns True if the string reads the same forwards and backwards.",
       "def is_palindrome(s):\n    return s == s[::-1]",
       [("is_palindrome('racecar')", True), ("is_palindrome('abc')", False), ("is_palindrome('')", True)]),
    _t("count_vowels", "Write a Python function count_vowels(s) that returns the number of vowels (a, e, i, o, u) in the string, case-insensitive.",
       "def count_vowels(s):\n    return sum(1 for c in s.lower() if c in 'aeiou')",
       [("count_vowels('Hello')", 2), ("count_vowels('xyz')", 0)]),
    _t("max_of_list", "Write a Python function max_of_list(nums) that returns the largest number in a non-empty list without using the built-in max.",
       '''
       def max_of_list(nums):
           best = nums[0]
           for n in nums[1:]:
               if n > best:
                   best = n
           return best
       ''', [("max_of_list([3, 1, 4, 1, 5])", 5), ("max_of_list([-2, -9])", -2)]),
    _t("sum_list", "Write a Python function sum_list(nums) that returns the sum of all numbers in the list without using the built-in sum.",
       '''
       def sum_list(nums):
           total = 0
           for n in nums:
               total += n
           return total
       ''', [("sum_list([1, 2, 3])", 6), ("sum_list([])", 0)]),
    _t("fizzbuzz", "Write a Python function fizzbuzz(n) that returns 'FizzBuzz' if n is divisible by 15, 'Fizz' if by 3, 'Buzz' if by 5, else str(n).",
       '''
       def fizzbuzz(n):
           if n % 15 == 0:
               return "FizzBuzz"
           if n % 3 == 0:
               return "Fizz"
           if n % 5 == 0:
               return "Buzz"
           return str(n)
       ''', [("fizzbuzz(15)", "FizzBuzz"), ("fizzbuzz(3)", "Fizz"), ("fizzbuzz(5)", "Buzz"), ("fizzbuzz(7)", "7")]),
    _t("is_even", "Write a Python function is_even(n) that returns True if n is even, else False.",
       "def is_even(n):\n    return n % 2 == 0",
       [("is_even(4)", True), ("is_even(7)", False)]),
    _t("celsius_to_fahrenheit", "Write a Python function celsius_to_fahrenheit(c) that converts Celsius to Fahrenheit.",
       "def celsius_to_fahrenheit(c):\n    return c * 9 / 5 + 32",
       [("celsius_to_fahrenheit(0)", 32.0), ("celsius_to_fahrenheit(100)", 212.0)]),
    _t("word_count", "Write a Python function word_count(s) that returns the number of whitespace-separated words in the string.",
       "def word_count(s):\n    return len(s.split())",
       [("word_count('hello world')", 2), ("word_count('  ')", 0), ("word_count('one')", 1)]),
    _t("unique", "Write a Python function unique(items) that returns a list of the items with duplicates removed, preserving first-seen order.",
       '''
       def unique(items):
           seen = set()
           out = []
           for x in items:
               if x not in seen:
                   seen.add(x)
                   out.append(x)
           return out
       ''', [("unique([1, 2, 2, 3, 1])", [1, 2, 3]), ("unique([])", [])]),
    _t("flatten", "Write a Python function flatten(nested) that flattens a list of lists into a single list (one level deep).",
       '''
       def flatten(nested):
           out = []
           for sub in nested:
               for x in sub:
                   out.append(x)
           return out
       ''', [("flatten([[1, 2], [3], []])", [1, 2, 3])]),
    _t("count_words", "Write a Python function count_words(s) that returns a dict mapping each whitespace-separated word to how many times it appears.",
       '''
       def count_words(s):
           counts = {}
           for w in s.split():
               counts[w] = counts.get(w, 0) + 1
           return counts
       ''', [("count_words('a b a')", {"a": 2, "b": 1}), ("count_words('')", {})]),
    _t("binary_search", "Write a Python function binary_search(arr, target) that returns the index of target in the sorted list arr, or -1 if not present.",
       '''
       def binary_search(arr, target):
           lo, hi = 0, len(arr) - 1
           while lo <= hi:
               mid = (lo + hi) // 2
               if arr[mid] == target:
                   return mid
               if arr[mid] < target:
                   lo = mid + 1
               else:
                   hi = mid - 1
           return -1
       ''', [("binary_search([1, 3, 5, 7], 5)", 2), ("binary_search([1, 3, 5, 7], 4)", -1)]),
    _t("bubble_sort", "Write a Python function bubble_sort(nums) that returns a new list with the numbers sorted in ascending order using bubble sort.",
       '''
       def bubble_sort(nums):
           arr = list(nums)
           n = len(arr)
           for i in range(n):
               for j in range(0, n - i - 1):
                   if arr[j] > arr[j + 1]:
                       arr[j], arr[j + 1] = arr[j + 1], arr[j]
           return arr
       ''', [("bubble_sort([3, 1, 2])", [1, 2, 3]), ("bubble_sort([])", [])]),
    _t("two_sum", "Write a Python function two_sum(nums, target) that returns a tuple of the two indices whose values add up to target, or None if no pair exists.",
       '''
       def two_sum(nums, target):
           seen = {}
           for i, n in enumerate(nums):
               if target - n in seen:
                   return (seen[target - n], i)
               seen[n] = i
           return None
       ''', [("two_sum([2, 7, 11], 9)", (0, 1)), ("two_sum([1, 2], 10)", None)]),
    _t("title_case", "Write a Python function title_case(s) that capitalizes the first letter of each word and lowercases the rest.",
       "def title_case(s):\n    return ' '.join(w[:1].upper() + w[1:].lower() for w in s.split())",
       [("title_case('hello world')", "Hello World"), ("title_case('ABC def')", "Abc Def")]),
    _t("digit_sum", "Write a Python function digit_sum(n) that returns the sum of the decimal digits of a non-negative integer n.",
       '''
       def digit_sum(n):
           total = 0
           while n > 0:
               total += n % 10
               n //= 10
           return total
       ''', [("digit_sum(123)", 6), ("digit_sum(0)", 0)]),
    _t("clamp", "Write a Python function clamp(x, lo, hi) that returns x constrained to the inclusive range [lo, hi].",
       "def clamp(x, lo, hi):\n    return max(lo, min(hi, x))",
       [("clamp(5, 0, 10)", 5), ("clamp(-1, 0, 10)", 0), ("clamp(99, 0, 10)", 10)]),
    _t("average", "Write a Python function average(nums) that returns the arithmetic mean of a non-empty list of numbers.",
       "def average(nums):\n    return sum(nums) / len(nums)",
       [("average([2, 4])", 3.0), ("average([5])", 5.0)]),
    _t("is_anagram", "Write a Python function is_anagram(a, b) that returns True if the two strings are anagrams of each other.",
       "def is_anagram(a, b):\n    return sorted(a) == sorted(b)",
       [("is_anagram('listen', 'silent')", True), ("is_anagram('abc', 'abd')", False)]),
    _t("second_largest", "Write a Python function second_largest(nums) that returns the second largest distinct value in the list, or None if there isn't one.",
       '''
       def second_largest(nums):
           distinct = sorted(set(nums), reverse=True)
           return distinct[1] if len(distinct) >= 2 else None
       ''', [("second_largest([1, 2, 3])", 2), ("second_largest([5, 5])", None)]),
    _t("running_total", "Write a Python function running_total(nums) that returns a list of cumulative sums of the input list.",
       '''
       def running_total(nums):
           out = []
           total = 0
           for n in nums:
               total += n
               out.append(total)
           return out
       ''', [("running_total([1, 2, 3])", [1, 3, 6]), ("running_total([])", [])]),
    _t("is_sorted", "Write a Python function is_sorted(nums) that returns True if the list is in non-decreasing order.",
       "def is_sorted(nums):\n    return all(nums[i] <= nums[i + 1] for i in range(len(nums) - 1))",
       [("is_sorted([1, 2, 2, 3])", True), ("is_sorted([3, 1])", False), ("is_sorted([])", True)]),
    _t("char_frequency", "Write a Python function char_frequency(s) that returns a dict mapping each character to its count in the string.",
       '''
       def char_frequency(s):
           freq = {}
           for c in s:
               freq[c] = freq.get(c, 0) + 1
           return freq
       ''', [("char_frequency('aab')", {"a": 2, "b": 1}), ("char_frequency('')", {})]),
    _t("to_snake_case", "Write a Python function to_snake_case(s) that converts a space-separated phrase to lowercase snake_case.",
       "def to_snake_case(s):\n    return '_'.join(s.lower().split())",
       [("to_snake_case('Hello World')", "hello_world"), ("to_snake_case('A B C')", "a_b_c")]),
    _t("power", "Write a Python function power(base, exp) that returns base raised to a non-negative integer exponent exp, without using ** or pow.",
       '''
       def power(base, exp):
           result = 1
           for _ in range(exp):
               result *= base
           return result
       ''', [("power(2, 10)", 1024), ("power(5, 0)", 1)]),
    _t("count_occurrences", "Write a Python function count_occurrences(items, target) that returns how many times target appears in the list.",
       '''
       def count_occurrences(items, target):
           count = 0
           for x in items:
               if x == target:
                   count += 1
           return count
       ''', [("count_occurrences([1, 2, 1, 1], 1)", 3), ("count_occurrences([], 1)", 0)]),
    _t("merge_dicts", "Write a Python function merge_dicts(a, b) that returns a new dict with a and b merged; on key conflict, b wins.",
       '''
       def merge_dicts(a, b):
           merged = dict(a)
           merged.update(b)
           return merged
       ''', [("merge_dicts({'x': 1}, {'y': 2})", {"x": 1, "y": 2}), ("merge_dicts({'x': 1}, {'x': 9})", {"x": 9})]),
    _t("chunk", "Write a Python function chunk(items, size) that splits the list into consecutive sublists of length size (the last may be shorter).",
       '''
       def chunk(items, size):
           return [items[i:i + size] for i in range(0, len(items), size)]
       ''', [("chunk([1, 2, 3, 4, 5], 2)", [[1, 2], [3, 4], [5]]), ("chunk([], 3)", [])]),
    _t("is_leap_year", "Write a Python function is_leap_year(year) that returns True if the Gregorian year is a leap year.",
       '''
       def is_leap_year(year):
           return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
       ''', [("is_leap_year(2000)", True), ("is_leap_year(1900)", False), ("is_leap_year(2024)", True)]),
    _t("remove_whitespace", "Write a Python function remove_whitespace(s) that returns the string with all whitespace characters removed.",
       "def remove_whitespace(s):\n    return ''.join(s.split())",
       [("remove_whitespace('a b\\tc')", "abc"), ("remove_whitespace('')", "")]),
]


def verify(task):
    """Compile + exec the solution and run its assertions. Returns (ok, detail)."""
    code = task["code"]
    try:
        compile(code, "<seed>", "exec")
    except SyntaxError as e:
        return False, f"syntax: {e}"
    ns = {}
    try:
        exec(code, ns)
    except Exception as e:  # noqa: BLE001
        return False, f"exec: {e}"
    for expr, want in task["checks"]:
        try:
            got = eval(expr, ns)  # noqa: S307 — trusted, self-authored expressions
        except Exception as e:  # noqa: BLE001
            return False, f"{expr} raised {e}"
        if got != want:
            return False, f"{expr} == {got!r}, expected {want!r}"
    return True, "ok"


def verify_candidate_sandboxed(code, asserts, timeout=8):
    """Verify an agent-generated coding task by EXECUTION in an isolated subprocess.

    Why a subprocess (vs the in-process verify() used for the trusted hardcoded seed):
    these candidates are model-authored, so a buggy one could infinite-loop or blow up.
    The subprocess gives a hard timeout and isolates state. Contract: the program
    `code + each assert` must exit 0. This is the Σ₀ ground-truth gate — a model's claim
    that its code works does NOT count; only a green subprocess does (#781).
    """
    if not asserts:
        return False, "no asserts"
    for a in asserts:
        if not a.strip().startswith("assert"):
            return False, f"not an assert: {a[:50]}"
    try:
        compile(code, "<extra>", "exec")
    except SyntaxError as e:
        return False, f"syntax: {e}"
    program = code.rstrip() + "\n\n" + "\n".join(asserts) + "\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(program)
        path = f.name
    try:
        r = subprocess.run([sys.executable, path], capture_output=True, timeout=timeout, text=True)
        if r.returncode == 0:
            return True, "ok"
        last = (r.stderr.strip().splitlines() or ["?"])[-1][:120]
        return False, last
    except subprocess.TimeoutExpired:
        return False, f"timeout(>{timeout}s)"
    except Exception as e:  # noqa: BLE001
        return False, f"runner: {e}"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# narrow blocklist: candidates are constrained to pure stdlib functions; reject any that
# reach for I/O / nondeterminism / process control before we even execute them.
_FORBIDDEN_TOKENS = ("import os", "import sys", "import socket", "import subprocess",
                     "open(", "input(", "eval(", "exec(", "__import__", "random.", "import random",
                     "time.", "import time", "datetime", "requests", "urllib", "shutil")


def load_extra_candidates(path, seed_fns):
    """Read a JSONL of model-generated {fn, instruction, code, asserts} candidates,
    execution-verify each, dedup (by fn name vs seed + by code hash), and return
    (verified_rows, dropped). verified_rows use the same {instruction, input, output} schema."""
    rows, dropped, seen_fns, seen_hashes = [], [], set(seed_fns), set()
    with open(path, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                t = json.loads(line)
            except json.JSONDecodeError as e:
                dropped.append((f"line{ln}", f"json: {e}"))
                continue
            fn = (t.get("fn") or "").strip()
            code = (t.get("code") or "").strip()
            instr = (t.get("instruction") or "").strip()
            asserts = t.get("asserts") or []
            if not (fn and code and instr):
                dropped.append((fn or f"line{ln}", "missing fn/code/instruction"))
                continue
            if f"def {fn}" not in code:
                dropped.append((fn, "code does not define fn"))
                continue
            if fn in seen_fns:
                dropped.append((fn, "duplicate fn name"))
                continue
            low = code.lower()
            bad = next((tok for tok in _FORBIDDEN_TOKENS if tok in low), None)
            if bad:
                dropped.append((fn, f"forbidden token: {bad!r}"))
                continue
            h = hashlib.sha1(code.encode("utf-8")).hexdigest()
            if h in seen_hashes:
                dropped.append((fn, "duplicate code body"))
                continue
            ok, detail = verify_candidate_sandboxed(code, asserts)
            if not ok:
                dropped.append((fn, detail))
                continue
            seen_fns.add(fn)
            seen_hashes.add(h)
            if not instr.endswith("Output only the function code."):
                instr = instr.rstrip(". ") + ". Output only the function code."
            rows.append({"instruction": instr, "input": "", "output": code})
    return rows, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=SEED_PATH)
    ap.add_argument("--merge", action="store_true",
                    help=f"also write {AUGMENTED_PATH} = existing training-data.jsonl + the verified seed (+extras)")
    ap.add_argument("--extra-candidates", default=None,
                    help="JSONL of model-generated {fn,instruction,code,asserts}; each is "
                         "execution-verified in a subprocess and deduped before inclusion")
    a = ap.parse_args()

    rows, dropped = [], []
    names = set()
    for task in TASKS:
        if task["fn"] in names:
            dropped.append((task["fn"], "duplicate fn name"))
            continue
        ok, detail = verify(task)
        if not ok:
            dropped.append((task["fn"], detail))
            continue
        names.add(task["fn"])
        rows.append({"instruction": task["instruction"], "input": "", "output": task["code"]})

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"verified {len(rows)}/{len(TASKS)} curated coding examples -> {a.out}")
    for fn, why in dropped:
        print(f"  DROPPED {fn}: {why}")
    if dropped:
        # the curated seed is hand-authored: ANY failure is a real regression, abort.
        raise SystemExit(f"ERROR: {len(dropped)} curated example(s) failed verification; none broken should ship")

    # Optional: fold in model-generated extras. Unlike the curated seed, drops here are
    # EXPECTED (the model writes some broken/duplicate tasks) and are informational, not fatal.
    extra_rows = []
    if a.extra_candidates:
        extra_rows, extra_dropped = load_extra_candidates(a.extra_candidates, names)
        with open(EXTRA_PATH, "w", encoding="utf-8") as f:
            for r in extra_rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        kept = len(extra_rows)
        total = kept + len(extra_dropped)
        print(f"extras: verified {kept}/{total} model-generated examples -> {EXTRA_PATH}")
        from collections import Counter
        reasons = Counter(why.split(":")[0].split("(")[0] for _, why in extra_dropped)
        for reason, c in reasons.most_common():
            print(f"  dropped x{c}: {reason}")

    if a.merge:
        existing = []
        if os.path.exists(EXISTING_PATH):
            with open(EXISTING_PATH, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        existing.append(line)
        with open(AUGMENTED_PATH, "w", encoding="utf-8") as f:
            for line in existing:
                f.write(line + "\n")
            for r in rows + extra_rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"merged {len(existing)} existing + {len(rows)} curated + {len(extra_rows)} extra "
              f"coding rows -> {AUGMENTED_PATH} ({len(existing) + len(rows) + len(extra_rows)} total)")


if __name__ == "__main__":
    main()
