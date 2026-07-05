"""RAM preflight guard for Ouro model loads.

Loading Ouro (~1.4-2.6B params) materializes ~1.5-3 GB of RAM. On the 12 GB dev
box, kicking off an eval while other evals / headless agent sessions are already
resident drives the machine into the paging-file OOM spiral (#781: 'OSError 1455:
paging file too small', and hard freezes when several loads race). This module is
the belt: call `require_free_ram()` at the top of every model-load path so a load
fails fast with a clear message instead of taking the whole box down.

Dependency-light on purpose — the minimal inference venv may not have psutil, so we
fall back to the OS: Windows GlobalMemoryStatusEx, Linux /proc/meminfo.
"""
from __future__ import annotations

import os
import sys

DEFAULT_MIN_FREE_GB = 3.0
SKIP_ENV = "OURO_SKIP_RAM_GUARD"   # set to "1" to bypass entirely
MIN_ENV = "OURO_MIN_FREE_GB"       # override the threshold (float GB)


def available_ram_gb():
    """Best-effort available (not just free) physical RAM in GB, or None if unknown."""
    # 1) psutil if present — most accurate ("available" accounts for reclaimable cache).
    try:
        import psutil  # type: ignore
        return psutil.virtual_memory().available / (1024 ** 3)
    except Exception:
        pass
    # 2) Windows: GlobalMemoryStatusEx → ullAvailPhys.
    if sys.platform.startswith("win"):
        try:
            import ctypes

            class _MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = _MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return stat.ullAvailPhys / (1024 ** 3)
        except Exception:
            pass
    # 3) Linux: /proc/meminfo MemAvailable (kB).
    else:
        try:
            with open("/proc/meminfo", "r") as fh:
                for line in fh:
                    if line.startswith("MemAvailable:"):
                        return int(line.split()[1]) * 1024 / (1024 ** 3)
        except Exception:
            pass
    return None


def require_free_ram(min_gb: float = DEFAULT_MIN_FREE_GB, what: str = "the Ouro model"):
    """Raise MemoryError if available RAM is below `min_gb` (env-overridable).

    - `OURO_SKIP_RAM_GUARD=1` bypasses the check entirely.
    - `OURO_MIN_FREE_GB=<float>` overrides the threshold.
    - If RAM can't be measured, the guard is a no-op (never block on unknown state).

    Returns the measured available GB (or None) on success.
    """
    if os.environ.get(SKIP_ENV) == "1":
        return available_ram_gb()
    env_min = os.environ.get(MIN_ENV)
    if env_min:
        try:
            min_gb = float(env_min)
        except ValueError:
            pass
    avail = available_ram_gb()
    if avail is None:
        return None  # unknown → don't block
    if avail < min_gb:
        raise MemoryError(
            f"Refusing to load {what}: only {avail:.1f} GB RAM available, need >= {min_gb:.1f} GB. "
            f"Free memory (close other evals / headless agent sessions) or set {SKIP_ENV}=1 to override "
            f"(tune the floor with {MIN_ENV}=<GB>)."
        )
    return avail
