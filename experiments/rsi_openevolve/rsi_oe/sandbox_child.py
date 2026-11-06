"""Sandboxed worker: run candidate priority functions on batches of instances.

Trusted harness code, started by sandbox.SandboxPool as `python -I sandbox_child.py` in a
temporary directory with a stripped environment (no API keys). Before it reads any
candidate code it caps its own memory at 1 GiB and, on Windows, forbids child processes;
if either cap fails it refuses to run candidates. It then serves tasks over stdin/stdout:
each message is an 8-byte little-endian length followed by an .npz payload. Every task
runs in a fresh namespace with a restricted builtins table; the parent has already
rejected code that imports anything but numpy/math, touches dunder or frame attributes,
or assigns attributes on imported modules. The worker returns bin assignments; the parent
verifies them and computes scores. The parent recycles a worker after a fixed number of
tasks and kills it on timeout.
"""
import io
import struct
import sys
import time

MEMORY_LIMIT = 1 << 30  # 1 GiB


def _cap_resources() -> None:
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_ulonglong) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                        ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t),
                        ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class EXTENDED(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC),
                        ("IoInfo", IO_COUNTERS),
                        ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                                wintypes.DWORD]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        job = k32.CreateJobObjectW(None, None)
        if not job:
            raise OSError("CreateJobObjectW failed")
        info = EXTENDED()
        info.BasicLimitInformation.LimitFlags = 0x100 | 0x8  # PROCESS_MEMORY | ACTIVE_PROCESS
        info.BasicLimitInformation.ActiveProcessLimit = 1
        info.ProcessMemoryLimit = MEMORY_LIMIT
        if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(f"SetInformationJobObject failed ({ctypes.get_last_error()})")
        if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
            raise OSError(f"AssignProcessToJobObject failed ({ctypes.get_last_error()})")
        _cap_resources.job = job  # keep the handle alive for the life of the process
    else:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))


def _read_msg(stream):
    head = stream.read(8)
    if len(head) < 8:
        return None
    (n,) = struct.unpack("<Q", head)
    return stream.read(n)


def _write_msg(stream, payload: bytes) -> None:
    stream.write(struct.pack("<Q", len(payload)))
    stream.write(payload)
    stream.flush()


def main() -> int:
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = io.StringIO()  # nothing may print into the protocol channel
    try:
        _cap_resources()
        capped, cap_error = True, ""
    except Exception as exc:  # fail closed: never run candidate code uncapped
        capped, cap_error = False, f"sandbox: could not cap resources: {exc}"

    import math
    import os

    import numpy as np

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from binpack_core import pack  # noqa: E402  (same packer the parent uses)

    real = __builtins__ if isinstance(__builtins__, dict) else vars(__builtins__)
    allowed_modules = {"numpy": np, "math": math}

    def _import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if level or root not in allowed_modules or "." in name:
            raise ImportError(f"import of {name} is not allowed")
        return allowed_modules[root]

    names = ("abs", "all", "any", "bool", "dict", "divmod", "enumerate", "filter", "float",
             "int", "isinstance", "len", "list", "map", "max", "min", "pow", "range",
             "reversed", "round", "set", "slice", "sorted", "sum", "tuple", "zip",
             "frozenset", "complex", "str", "repr", "issubclass", "iter", "next",
             "ValueError", "TypeError", "ZeroDivisionError", "IndexError", "KeyError",
             "ArithmeticError", "FloatingPointError", "OverflowError", "Exception",
             "RuntimeError", "StopIteration", "True", "False", "None")
    safe_template = {n: real[n] for n in names if n in real}
    safe_template["__import__"] = _import
    safe_template["print"] = lambda *a, **k: None

    def result(status, message="", assign=None, cpu=0.0) -> bytes:
        buf = io.BytesIO()
        np.savez(buf, status=np.array(status), message=np.array(message[:2000]),
                 assign=np.asarray(assign if assign is not None else [], dtype=np.int32),
                 cpu=np.array(cpu))
        return buf.getvalue()

    while True:
        msg = _read_msg(stdin)
        if msg is None:
            return 0
        if not capped:
            _write_msg(stdout, result("error", cap_error))
            continue
        with np.load(io.BytesIO(msg), allow_pickle=False) as t:
            code = bytes(t["code"]).decode("utf-8")
            items = t["items"]
            lengths = t["lengths"]
            capacity = int(t["capacity"][0])
            cpu_per_item = float(t["cpu_per_item"][0])
        try:
            compiled = compile(code, "<candidate>", "exec")
        except Exception as exc:
            _write_msg(stdout, result("error", f"compile: {type(exc).__name__}: {exc}"))
            continue
        out = np.empty(int(lengths.sum()), dtype=np.int32)
        pos, cpu_total, done, failure = 0, 0.0, 0, None
        old_err = np.seterr(all="ignore")
        for n in lengths:
            n = int(n)
            ns = {"__builtins__": dict(safe_template), "__name__": "candidate"}
            try:
                t0 = time.process_time()
                # Running model-written code is this process's job. The code passed
                # sandbox.check_code's AST rules; it gets restricted builtins and a
                # numpy/math-only import; this process holds no keys, is memory-capped and
                # may not start children; and the parent re-verifies every packing.
                exec(compiled, ns)  # noqa: S102
                fn = ns.get("priority")
                if not callable(fn):
                    raise ValueError("priority is not callable")
                assign, _ = pack(items[pos:pos + n], capacity, fn)
                cpu_total += time.process_time() - t0
            except MemoryError:
                failure = "MemoryError (over the 1 GiB cap)"
                break
            except Exception as exc:
                failure = f"{type(exc).__name__}: {str(exc)[:300]}"
                break
            out[pos:pos + n] = assign
            pos += n
            done += n
            if cpu_total > cpu_per_item * done + 0.5:
                failure = (f"too slow: {1e3 * cpu_total / done:.2f} ms per item "
                           f"(limit {1e3 * cpu_per_item:.1f})")
                break
        np.seterr(**old_err)
        if failure:
            _write_msg(stdout, result("error", failure, cpu=cpu_total))
        else:
            _write_msg(stdout, result("ok", assign=out, cpu=cpu_total))


if __name__ == "__main__":
    sys.exit(main())
