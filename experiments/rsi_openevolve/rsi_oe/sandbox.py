"""Run LLM-written priority functions without trusting them.

Three layers, each enough on its own for the code this loop produces (bin-packing
heuristics, not adversarial payloads), together the sandbox boundary the experiment
claims:

1. Static check (`check_code`): only `numpy` and `math` may be imported; no
   double-underscore names or attributes; no file, pickle, process or random APIs; no
   `exec`/`eval`/`getattr`-style builtins. Randomness is banned so a score is a fixed
   property of the code.
2. A separate interpreter (`python -I`) with a stripped environment (no API keys), a
   temporary working directory, a 1 GiB memory cap it sets on itself before touching
   candidate code (Windows job object / POSIX rlimit; it refuses to run if the cap
   fails), a restricted builtins table, and a wall-clock timeout from the parent.
3. The parent re-verifies every returned assignment (`binpack.verify_assignment`), so a
   candidate cannot report bins it did not use.

The child returns per-instance bin assignments; scoring happens here, in the parent.
"""
from __future__ import annotations

import ast
import hashlib
import io
import os
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np

from . import binpack

CHILD_SCRIPT = Path(__file__).with_name("sandbox_child.py")
MAX_CODE_CHARS = 6000
CPU_SECONDS_PER_ITEM = 1e-3  # a candidate slower than 1 ms per item is invalid

ALLOWED_IMPORTS = {"numpy", "math"}
BANNED_NAMES = {
    "open", "exec", "eval", "compile", "__import__", "globals", "locals", "vars",
    "getattr", "setattr", "delattr", "input", "breakpoint", "exit", "quit", "help",
    "memoryview", "dir", "super", "object", "type", "classmethod", "staticmethod",
    "property", "__builtins__", "id", "hash",
}
BANNED_ATTRS = {
    # file and serialization APIs
    "load", "loads", "save", "savez", "savez_compressed", "savetxt", "loadtxt",
    "genfromtxt", "fromfile", "tofile", "memmap", "dump", "dumps", "fromregex",
    "DataSource", "open",
    # escape hatches and non-determinism
    "ctypeslib", "lib", "core", "f2py", "distutils", "testing", "random", "os", "sys",
    "subprocess", "builtins", "importlib", "inspect", "pickle", "marshal", "shutil",
    "socket", "pathlib", "io", "glob", "tempfile", "threading", "multiprocessing",
    "ctypes", "gc", "weakref", "code", "runpy", "site", "time", "signal",
    "show_config", "info", "source", "get_include",
    # frame and code objects (a generator's frame leads back to the harness)
    "gi_frame", "gi_code", "gi_yieldfrom", "cr_frame", "cr_code", "cr_await", "ag_frame",
    "ag_code", "f_back", "f_globals", "f_locals", "f_builtins", "f_code", "f_trace",
    "tb_frame", "tb_next", "co_code", "func_globals", "func_code",
}
BANNED_NODES = (ast.With, ast.AsyncWith, ast.AsyncFunctionDef, ast.Await, ast.AsyncFor)


class CodeRejected(ValueError):
    pass


def check_code(code: str) -> None:
    """Raise CodeRejected if the candidate breaks the static rules."""
    if len(code) > MAX_CODE_CHARS:
        raise CodeRejected(f"code is {len(code)} chars, limit {MAX_CODE_CHARS}")
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise CodeRejected(f"syntax error: {exc.msg} (line {exc.lineno})") from None
    has_priority = False
    module_names = set()  # names bound by import statements (np, math, linalg, ...)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                module_names.add((alias.asname or alias.name).split(".")[0])
    for node in ast.walk(tree):
        if isinstance(node, BANNED_NODES):
            raise CodeRejected(f"{type(node).__name__} is not allowed")
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_IMPORTS or "." in alias.name:
                    raise CodeRejected(f"import {alias.name} is not allowed")
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "") not in ALLOWED_IMPORTS:
                raise CodeRejected(f"from {node.module} import is not allowed")
            for alias in node.names:
                if alias.name == "*" or alias.name.startswith("_") or alias.name in BANNED_ATTRS:
                    raise CodeRejected(f"importing {alias.name} is not allowed")
        elif isinstance(node, ast.Name):
            if node.id in BANNED_NAMES or node.id.startswith("__"):
                raise CodeRejected(f"name {node.id} is not allowed")
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("_") or node.attr in BANNED_ATTRS:
                raise CodeRejected(f"attribute .{node.attr} is not allowed")
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                root = node.value
                while isinstance(root, ast.Attribute):
                    root = root.value
                if isinstance(root, ast.Name) and root.id in module_names:
                    raise CodeRejected(f"assigning attributes of module {root.id} is not allowed")
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            if node.name == "priority" and isinstance(node, ast.FunctionDef):
                if node in tree.body:
                    has_priority = True
    if not has_priority:
        raise CodeRejected("no top-level function named priority")


def code_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()[:16]


@dataclass
class EvalOutcome:
    """Result of running one program on a list of instances."""
    ok: bool
    bins: Dict[str, int] = field(default_factory=dict)  # instance key -> bins used
    error: str = ""
    cpu_seconds: float = 0.0
    wall_seconds: float = 0.0


def _child_env() -> Dict[str, str]:
    keep = ("SYSTEMROOT", "SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "NUMBER_OF_PROCESSORS")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["OMP_NUM_THREADS"] = "1"
    env["OPENBLAS_NUM_THREADS"] = "1"
    env["MKL_NUM_THREADS"] = "1"
    return env


class _Worker:
    def __init__(self, python: str):
        self.tmp = tempfile.TemporaryDirectory(prefix="rsi_oe_w_")
        self.errlog = open(Path(self.tmp.name) / "stderr.log", "wb")
        self.proc = subprocess.Popen(
            [python, "-I", str(CHILD_SCRIPT)], cwd=self.tmp.name, env=_child_env(),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errlog,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.replies: "queue.Queue[Optional[bytes]]" = queue.Queue()
        self.tasks = 0
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self) -> None:
        out = self.proc.stdout
        try:
            while True:
                head = out.read(8)
                if len(head) < 8:
                    break
                (n,) = struct.unpack("<Q", head)
                self.replies.put(out.read(n))
        except Exception:
            pass
        self.replies.put(None)

    def request(self, payload: bytes, timeout: float) -> Optional[bytes]:
        self.tasks += 1
        self.proc.stdin.write(struct.pack("<Q", len(payload)) + payload)
        self.proc.stdin.flush()
        return self.replies.get(timeout=timeout)

    def close(self) -> None:
        try:
            self.proc.kill()
            self.proc.wait(timeout=10)
        except Exception:
            pass
        try:
            self.errlog.close()
            self.tmp.cleanup()
        except Exception:
            pass


class SandboxPool:
    """A few long-lived sandbox workers, recycled every `max_tasks` tasks."""

    def __init__(self, size: int = 1, python: Optional[str] = None, max_tasks: int = 200):
        self.python = python or sys.executable
        self.max_tasks = max_tasks
        self.idle: "queue.Queue[_Worker]" = queue.Queue()
        for _ in range(size):
            self.idle.put(_Worker(self.python))

    def run(self, code: str, instances: Sequence[binpack.Instance], timeout: float) -> "EvalOutcome":
        t0 = time.time()
        try:
            check_code(code)
        except CodeRejected as exc:
            return EvalOutcome(False, error=f"rejected: {exc}")
        if not instances:
            return EvalOutcome(True)
        lengths = np.array([len(i.items) for i in instances], dtype=np.int64)
        buf = io.BytesIO()
        np.savez(buf,
                 code=np.frombuffer(code.encode("utf-8"), dtype=np.uint8),
                 items=np.concatenate([i.items for i in instances]).astype(np.int16),
                 lengths=lengths,
                 capacity=np.array([binpack.CAPACITY]),
                 cpu_per_item=np.array([CPU_SECONDS_PER_ITEM]))
        worker = self.idle.get()
        reply, keep = None, True
        try:
            try:
                reply = worker.request(buf.getvalue(), timeout)
            except queue.Empty:
                keep = False
                return EvalOutcome(False, error=f"timeout after {timeout:.0f}s",
                                   wall_seconds=time.time() - t0)
            except OSError as exc:
                keep = False
                return EvalOutcome(False, error=f"worker pipe failed: {exc}",
                                   wall_seconds=time.time() - t0)
            if reply is None:
                keep = False
                return EvalOutcome(False, error="worker died", wall_seconds=time.time() - t0)
        finally:
            if not keep or worker.tasks >= self.max_tasks:
                worker.close()
                worker = _Worker(self.python)
            self.idle.put(worker)
        with np.load(io.BytesIO(reply), allow_pickle=False) as res:
            status = str(res["status"])
            cpu = float(res["cpu"])
            if status != "ok":
                return EvalOutcome(False, error=str(res["message"])[:400], cpu_seconds=cpu,
                                   wall_seconds=time.time() - t0)
            assign = res["assign"]
        bins: Dict[str, int] = {}
        pos = 0
        for inst, n in zip(instances, lengths):
            a = assign[pos:pos + n]
            pos += n
            try:
                bins[inst.key] = binpack.verify_assignment(inst, a)
            except ValueError as exc:
                return EvalOutcome(False, error=f"invalid packing on {inst.key}: {exc}")
        return EvalOutcome(True, bins=bins, cpu_seconds=cpu, wall_seconds=time.time() - t0)

    def close(self) -> None:
        while not self.idle.empty():
            self.idle.get().close()


_DEFAULT_POOL: Optional[SandboxPool] = None


def run_program(code: str, instances: Sequence[binpack.Instance], timeout: float) -> EvalOutcome:
    """Convenience wrapper over a lazily created one-worker pool."""
    global _DEFAULT_POOL
    if _DEFAULT_POOL is None:
        _DEFAULT_POOL = SandboxPool(1)
    return _DEFAULT_POOL.run(code, instances, timeout)
