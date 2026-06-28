"""Symbol-graph repo-map with PageRank file ranking.

Assembles the *minimum sufficient* slice of a codebase for a named task: it
extracts the symbols each file defines and references, builds a directed graph
(files are nodes; an edge A->B means A references a symbol B defines), and ranks
files by PageRank. Highly-referenced files (the load-bearing ones) float to the
top of the context slice.

This is the Σ₀ "Remember/Reason" context-assembly primitive (issues #1409/#1413).

Approach ported from Aider's repository map (Apache-2.0):
https://aider.chat/docs/repomap.html — see THIRD-PARTY-NOTICES.md. This is a
clean-room, dependency-light re-implementation (stdlib only; regex symbol
extraction instead of tree-sitter, hand-rolled PageRank instead of networkx).
Tree-sitter precision is a planned follow-up upgrade.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Symbol extraction
# ---------------------------------------------------------------------------

# Per-language patterns for *definitions*. Each regex's first group is the name.
_DEF_PATTERNS: dict[str, list[re.Pattern]] = {
    ".py": [
        re.compile(r"^\s*def\s+([A-Za-z_]\w*)"),
        re.compile(r"^\s*class\s+([A-Za-z_]\w*)"),
    ],
    ".js": [
        re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"),
        re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)"),
        re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*="),
    ],
}
# JS patterns apply to the whole TS/JSX family too.
for _ext in (".ts", ".jsx", ".tsx", ".mjs", ".cjs"):
    _DEF_PATTERNS[_ext] = _DEF_PATTERNS[".js"]

# An identifier "reference" is any word-like token. We subtract a small stoplist
# of language keywords so e.g. `def`/`class`/`return` don't masquerade as refs.
_IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")
_STOPWORDS = frozenset(
    """
    def class return import from as if elif else for while try except finally with
    function const let var export default async await new this super extends yield
    true false none null undefined and or not in is pass break continue lambda
    typeof instanceof void delete case switch throw do of
    """.split()
)

# Identifiers shorter than this are too noisy to be useful graph edges.
_MIN_SYMBOL_LEN = 3


def _ext_of(path: str) -> str:
    return os.path.splitext(path)[1].lower()


def extract_symbols(text: str, ext: str) -> tuple[set[str], set[str]]:
    """Return (defined, referenced) symbol name sets for one file's *text*."""
    defined: set[str] = set()
    patterns = _DEF_PATTERNS.get(ext, [])
    for line in text.splitlines():
        for pat in patterns:
            m = pat.match(line)
            if m:
                defined.add(m.group(1))
    referenced = {
        tok
        for tok in _IDENT_RE.findall(text)
        if len(tok) >= _MIN_SYMBOL_LEN and tok not in _STOPWORDS
    }
    return defined, referenced


# ---------------------------------------------------------------------------
# PageRank (hand-rolled power iteration; no networkx dependency)
# ---------------------------------------------------------------------------

def pagerank(
    nodes: list[str],
    edges: dict[str, dict[str, float]],
    damping: float = 0.85,
    iterations: int = 50,
    tol: float = 1.0e-8,
) -> dict[str, float]:
    """PageRank over a weighted directed graph.

    ``edges[a][b] = w`` is the weight of the link a->b. Dangling nodes (no
    out-links) redistribute their rank uniformly, the standard formulation.
    """
    n = len(nodes)
    if n == 0:
        return {}
    rank = {node: 1.0 / n for node in nodes}
    out_weight = {a: sum(targets.values()) for a, targets in edges.items()}
    base = (1.0 - damping) / n

    for _ in range(iterations):
        dangling = sum(rank[a] for a in nodes if out_weight.get(a, 0.0) == 0.0)
        new = {node: base + damping * dangling / n for node in nodes}
        for a, targets in edges.items():
            wa = out_weight.get(a, 0.0)
            if wa == 0.0:
                continue
            ra = rank[a]
            for b, w in targets.items():
                new[b] += damping * ra * (w / wa)
        delta = sum(abs(new[node] - rank[node]) for node in nodes)
        rank = new
        if delta < tol:
            break
    return rank


# ---------------------------------------------------------------------------
# Repo map
# ---------------------------------------------------------------------------

@dataclass
class FileEntry:
    path: str
    score: float
    defined: list[str] = field(default_factory=list)


_DEFAULT_SKIP_DIRS = frozenset(
    {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
     ".claude", "data", "vendor"}
)


def _iter_source_files(root: str, skip_dirs: frozenset[str]):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for name in filenames:
            if _ext_of(name) in _DEF_PATTERNS:
                yield os.path.join(dirpath, name)


def build_repo_map(
    root: str,
    focus_files: list[str] | None = None,
    max_files: int = 30,
    skip_dirs: frozenset[str] = _DEFAULT_SKIP_DIRS,
) -> list[FileEntry]:
    """Rank files in *root* by PageRank over the symbol-reference graph.

    ``focus_files`` (absolute or root-relative paths), when given, personalizes
    the ranking: a file gets a score bonus for defining symbols that the focus
    files reference, surfacing the context most relevant to the task at hand.
    Returns up to ``max_files`` entries, highest score first.
    """
    defs: dict[str, set[str]] = {}
    refs: dict[str, set[str]] = {}
    for path in _iter_source_files(root, skip_dirs):
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except OSError:
            continue
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        d, r = extract_symbols(text, _ext_of(path))
        defs[rel] = d
        refs[rel] = r

    # symbol -> set of files that define it
    definer: dict[str, set[str]] = {}
    for rel, names in defs.items():
        for name in names:
            definer.setdefault(name, set()).add(rel)

    nodes = list(defs.keys())
    edges: dict[str, dict[str, float]] = {rel: {} for rel in nodes}
    for rel, referenced in refs.items():
        for sym in referenced:
            for target in definer.get(sym, ()):  # noqa: B007
                if target == rel:
                    continue  # ignore self-references
                edges[rel][target] = edges[rel].get(target, 0.0) + 1.0

    scores = pagerank(nodes, edges)

    if focus_files:
        focus_rel = {
            os.path.relpath(f, root).replace(os.sep, "/") if os.path.isabs(f) else f
            for f in focus_files
        }
        wanted: set[str] = set()
        for f in focus_rel:
            wanted |= refs.get(f, set())
        if wanted:
            top = max(scores.values()) if scores else 1.0
            for rel in nodes:
                overlap = len(defs[rel] & wanted)
                if overlap:
                    scores[rel] = scores.get(rel, 0.0) + overlap * top

    entries = [
        FileEntry(path=rel, score=scores.get(rel, 0.0), defined=sorted(defs[rel]))
        for rel in nodes
    ]
    entries.sort(key=lambda e: (-e.score, e.path))
    return entries[:max_files]


def render_repo_map(entries: list[FileEntry], max_symbols: int = 8) -> str:
    """Render a repo-map slice as a compact text block for an LLM prompt."""
    lines: list[str] = []
    for e in entries:
        syms = ", ".join(e.defined[:max_symbols])
        more = "" if len(e.defined) <= max_symbols else f", +{len(e.defined) - max_symbols} more"
        lines.append(f"{e.path}" + (f"  [{syms}{more}]" if syms else ""))
    return "\n".join(lines)
