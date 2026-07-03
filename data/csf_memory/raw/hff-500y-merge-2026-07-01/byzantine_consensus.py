#!/usr/bin/env python3
"""
Teaching implementation of PBFT (Practical Byzantine Fault Tolerance).

Handles happy path and basic view changes. Does not handle checkpoint garbage
collection, state transfer, or network partitions.

References
----------
Castro, M. & Liskov, B. (1999). "Practical Byzantine Fault Tolerance."
Proceedings of the Third Symposium on Operating Systems Design and
Implementation (OSDI '99).
"""

import argparse
import hashlib
import json
import os
import sqlite3
import threading
import time
from dataclasses import asdict, dataclass, field
from enum import Enum, auto
from typing import Any, Dict, List, Optional, Set, Tuple

import requests
from flask import Blueprint, Flask, jsonify, request as flask_request

# ---------------------------------------------------------------------------
# Constants & enums
# ---------------------------------------------------------------------------

DB_PATH = os.environ.get("PBFT_DB_PATH", "./data/pbft.db")


class Phase(str, Enum):
    PRE_PREPARE = "pre-prepare"
    PREPARE = "prepare"
    COMMIT = "commit"


class ConsensusState(str, Enum):
    IDLE = "idle"
    PRE_PREPARED = "pre-prepared"
    PREPARED = "prepared"
    COMMITTED = "committed"


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class PBFTMessage:
    """A single PBFT protocol message."""

    phase: str
    view: int
    sequence: int
    digest: str
    node_id: str
    payload: Optional[dict] = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "PBFTMessage":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class ViewChangeMessage:
    """View-change request sent when the leader is suspected faulty."""

    new_view: int
    node_id: str
    # Sequence number of the last stable checkpoint (simplified)
    last_sequence: int

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ViewChangeMessage":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


# ---------------------------------------------------------------------------
# Quorum helpers
# ---------------------------------------------------------------------------


def max_faulty(n: int) -> int:
    """Return f, the maximum number of faulty nodes tolerated."""
    return (n - 1) // 3


def quorum_size(n: int) -> int:
    """Return 2f + 1."""
    return 2 * max_faulty(n) + 1


def _digest(payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


# ---------------------------------------------------------------------------
# SQLite persistence
# ---------------------------------------------------------------------------


def init_consensus_db(db_path: str = DB_PATH) -> None:
    """Create the local PBFT state tables if they do not exist."""
    os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    c.execute(
        """
        CREATE TABLE IF NOT EXISTS pbft_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            phase       TEXT    NOT NULL,
            view        INTEGER NOT NULL,
            sequence    INTEGER NOT NULL,
            digest      TEXT    NOT NULL,
            node_id     TEXT    NOT NULL,
            payload     TEXT,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(phase, view, sequence, node_id)
        )
    """
    )

    c.execute(
        """
        CREATE TABLE IF NOT EXISTS committed_requests (
            sequence    INTEGER PRIMARY KEY,
            view        INTEGER NOT NULL,
            digest      TEXT    NOT NULL,
            payload     TEXT,
            committed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """
    )

    c.execute(
        """
        CREATE TABLE IF NOT EXISTS view_changes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            new_view    INTEGER NOT NULL,
            node_id     TEXT    NOT NULL,
            last_sequence INTEGER NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(new_view, node_id)
        )
    """
    )

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# PBFTNode — core protocol logic
# ---------------------------------------------------------------------------


class PBFTNode:
    """A single node participating in PBFT consensus.

    Parameters
    ----------
    node_id : str
        Unique identifier for this node.
    peers : list[str]
        HTTP base URLs of the other nodes (e.g. ``["http://127.0.0.1:6001"]``).
    db_path : str
        Path to the SQLite database for local persistence.
    """

    def __init__(
        self,
        node_id: str,
        peers: List[str],
        db_path: str = DB_PATH,
    ) -> None:
        self.node_id = node_id
        self.peers = list(peers)
        self.db_path = db_path

        # All known node IDs, sorted for deterministic leader election.
        self._all_ids: List[str] = sorted(set([self.node_id] + [self._peer_id(p) for p in self.peers]))
        self.n = len(self._all_ids)
        self.f = max_faulty(self.n)

        self.view = 0
        self.sequence = 0
        self.lock = threading.Lock()

        # In-memory message logs for quorum counting
        # key: (view, sequence, phase) -> set of node_ids
        self._message_log: Dict[Tuple[int, int, str], Set[str]] = {}
        # key: (view, sequence, phase, node_id) -> digest  — for equivocation detection
        self._sent_digests: Dict[Tuple[int, int, str, str], str] = {}

        # View-change tracking
        # key: new_view -> set of node_ids
        self._view_change_votes: Dict[int, Set[str]] = {}

        init_consensus_db(self.db_path)

    # -- helpers -------------------------------------------------------------

    @staticmethod
    def _peer_id(url: str) -> str:
        """Derive a stable node-id from a peer URL (used for sorting only)."""
        return url.rstrip("/")

    @property
    def leader_id(self) -> str:
        """Current leader based on view number."""
        return self._all_ids[self.view % self.n]

    @property
    def is_leader(self) -> bool:
        return self.leader_id == self.node_id

    def _quorum(self) -> int:
        return quorum_size(self.n)

    # -- equivocation detection ----------------------------------------------

    def _check_equivocation(self, msg: PBFTMessage) -> bool:
        """Return True if this message is equivocating (conflicting digest
        from the same node in the same view/sequence/phase)."""
        key = (msg.view, msg.sequence, msg.phase, msg.node_id)
        previous = self._sent_digests.get(key)
        if previous is not None and previous != msg.digest:
            return True  # equivocation detected
        return False

    def _record_message(self, msg: PBFTMessage) -> None:
        """Record a message for quorum counting and equivocation tracking."""
        log_key = (msg.view, msg.sequence, msg.phase)
        self._message_log.setdefault(log_key, set()).add(msg.node_id)

        eq_key = (msg.view, msg.sequence, msg.phase, msg.node_id)
        self._sent_digests[eq_key] = msg.digest

        # Persist to SQLite
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute(
                """INSERT OR IGNORE INTO pbft_log (phase, view, sequence, digest, node_id, payload)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (msg.phase, msg.view, msg.sequence, msg.digest, msg.node_id,
                 json.dumps(msg.payload) if msg.payload else None),
            )
            conn.commit()
            conn.close()
        except Exception:
            pass  # best-effort persistence

    def _count_messages(self, view: int, sequence: int, phase: str) -> int:
        return len(self._message_log.get((view, sequence, phase), set()))

    # -- broadcast -----------------------------------------------------------

    def _broadcast(self, endpoint: str, data: dict) -> None:
        """Send *data* to every peer via HTTP POST (fire-and-forget)."""
        for peer in self.peers:
            url = f"{peer.rstrip('/')}{endpoint}"
            try:
                requests.post(url, json=data, timeout=2)
            except requests.RequestException:
                pass  # peer might be down; that is expected in BFT

    # -- protocol phases -----------------------------------------------------

    def request(self, payload: dict) -> dict:
        """Client request entry-point (leader only).

        If this node is not the leader, it returns an error indicating who
        the leader is so the client can redirect.
        """
        if not self.is_leader:
            return {
                "error": "not_leader",
                "leader": self.leader_id,
                "view": self.view,
            }

        with self.lock:
            self.sequence += 1
            seq = self.sequence

        digest = _digest(payload)
        msg = PBFTMessage(
            phase=Phase.PRE_PREPARE,
            view=self.view,
            sequence=seq,
            digest=digest,
            node_id=self.node_id,
            payload=payload,
        )

        self._record_message(msg)
        self._broadcast("/pbft/pre-prepare", msg.to_dict())

        return {
            "status": "pre-prepare_broadcast",
            "view": self.view,
            "sequence": seq,
            "digest": digest,
        }

    def handle_pre_prepare(self, data: dict) -> dict:
        """Receive a pre-prepare from the leader."""
        msg = PBFTMessage.from_dict(data)

        # Validate sender is the leader for this view
        expected_leader = self._all_ids[msg.view % self.n]
        if msg.node_id != expected_leader:
            return {"error": "sender_not_leader"}

        if msg.view != self.view:
            return {"error": "view_mismatch", "expected": self.view}

        # Verify digest
        if msg.payload and _digest(msg.payload) != msg.digest:
            return {"error": "digest_mismatch"}

        if self._check_equivocation(msg):
            return {"error": "equivocation_detected", "node": msg.node_id}

        self._record_message(msg)

        # Broadcast PREPARE
        prepare = PBFTMessage(
            phase=Phase.PREPARE,
            view=msg.view,
            sequence=msg.sequence,
            digest=msg.digest,
            node_id=self.node_id,
            payload=msg.payload,
        )
        self._record_message(prepare)
        self._broadcast("/pbft/prepare", prepare.to_dict())

        return {"status": "prepare_broadcast", "sequence": msg.sequence}

    def handle_prepare(self, data: dict) -> dict:
        """Receive a prepare message from a peer."""
        msg = PBFTMessage.from_dict(data)

        if msg.view != self.view:
            return {"error": "view_mismatch"}

        if self._check_equivocation(msg):
            return {"error": "equivocation_detected", "node": msg.node_id}

        self._record_message(msg)

        count = self._count_messages(msg.view, msg.sequence, Phase.PREPARE)

        # Need 2f + 1 prepares (including own) to move to commit
        if count >= self._quorum():
            commit = PBFTMessage(
                phase=Phase.COMMIT,
                view=msg.view,
                sequence=msg.sequence,
                digest=msg.digest,
                node_id=self.node_id,
                payload=msg.payload,
            )
            self._record_message(commit)
            self._broadcast("/pbft/commit", commit.to_dict())
            return {"status": "commit_broadcast", "sequence": msg.sequence}

        return {
            "status": "prepare_recorded",
            "count": count,
            "needed": self._quorum(),
        }

    def handle_commit(self, data: dict) -> dict:
        """Receive a commit message from a peer."""
        msg = PBFTMessage.from_dict(data)

        if msg.view != self.view:
            return {"error": "view_mismatch"}

        if self._check_equivocation(msg):
            return {"error": "equivocation_detected", "node": msg.node_id}

        self._record_message(msg)

        count = self._count_messages(msg.view, msg.sequence, Phase.COMMIT)

        if count >= self._quorum():
            # Consensus reached — execute / persist
            self._execute(msg)
            return {
                "status": "committed",
                "sequence": msg.sequence,
                "digest": msg.digest,
            }

        return {
            "status": "commit_recorded",
            "count": count,
            "needed": self._quorum(),
        }

    def _execute(self, msg: PBFTMessage) -> None:
        """Persist a committed request to the local store."""
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute(
                """INSERT OR IGNORE INTO committed_requests (sequence, view, digest, payload)
                   VALUES (?, ?, ?, ?)""",
                (msg.sequence, msg.view, msg.digest,
                 json.dumps(msg.payload) if msg.payload else None),
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

    # -- view change ---------------------------------------------------------

    def request_view_change(self) -> dict:
        """Initiate a view change (leader suspected faulty)."""
        new_view = self.view + 1
        vc = ViewChangeMessage(
            new_view=new_view,
            node_id=self.node_id,
            last_sequence=self.sequence,
        )

        self._view_change_votes.setdefault(new_view, set()).add(self.node_id)

        # Persist
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute(
                """INSERT OR IGNORE INTO view_changes (new_view, node_id, last_sequence)
                   VALUES (?, ?, ?)""",
                (new_view, self.node_id, self.sequence),
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

        self._broadcast("/pbft/view-change", vc.to_dict())
        return {"status": "view_change_requested", "new_view": new_view}

    def handle_view_change(self, data: dict) -> dict:
        """Receive a view-change vote from a peer."""
        vc = ViewChangeMessage.from_dict(data)
        self._view_change_votes.setdefault(vc.new_view, set()).add(vc.node_id)

        # Persist
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute(
                """INSERT OR IGNORE INTO view_changes (new_view, node_id, last_sequence)
                   VALUES (?, ?, ?)""",
                (vc.new_view, vc.node_id, vc.last_sequence),
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

        votes = len(self._view_change_votes.get(vc.new_view, set()))

        if votes >= self._quorum():
            # Enough votes — advance to new view
            self.view = vc.new_view
            new_leader = self._all_ids[self.view % self.n]

            # If we are the new leader, broadcast new-view
            if new_leader == self.node_id:
                self._broadcast(
                    "/pbft/new-view",
                    {"new_view": self.view, "leader": self.node_id},
                )

            return {
                "status": "view_changed",
                "new_view": self.view,
                "new_leader": new_leader,
            }

        return {
            "status": "view_change_recorded",
            "votes": votes,
            "needed": self._quorum(),
        }

    def handle_new_view(self, data: dict) -> dict:
        """Receive a new-view announcement from the new leader."""
        new_view = data.get("new_view", 0)
        leader = data.get("leader", "")

        expected_leader = self._all_ids[new_view % self.n]
        if leader != expected_leader:
            return {"error": "invalid_new_view_leader"}

        self.view = new_view
        return {"status": "new_view_accepted", "view": self.view, "leader": leader}

    # -- status / queries ----------------------------------------------------

    def status(self) -> dict:
        """Return current node status."""
        committed = []
        try:
            conn = sqlite3.connect(self.db_path)
            c = conn.cursor()
            c.execute("SELECT sequence, digest FROM committed_requests ORDER BY sequence")
            committed = [{"sequence": r[0], "digest": r[1]} for r in c.fetchall()]
            conn.close()
        except Exception:
            pass

        return {
            "node_id": self.node_id,
            "view": self.view,
            "sequence": self.sequence,
            "leader": self.leader_id,
            "is_leader": self.is_leader,
            "n": self.n,
            "f": self.f,
            "quorum": self._quorum(),
            "committed_count": len(committed),
            "committed": committed[-20:],  # last 20
        }


# ---------------------------------------------------------------------------
# Backward-compatibility helpers used by app.py
# ---------------------------------------------------------------------------

# These operate on the old-style proposals/votes tables so that app.py can
# continue to import them without changes.  They are independent of the PBFT
# protocol above.

_COMPAT_DB = os.environ.get("CONSENSUS_DB_PATH", "./data/byzantine.db")


def _ensure_compat_db() -> None:
    os.makedirs(os.path.dirname(_COMPAT_DB) or ".", exist_ok=True)
    conn = sqlite3.connect(_COMPAT_DB)
    c = conn.cursor()
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS proposals (
            id INTEGER PRIMARY KEY,
            violation_id TEXT UNIQUE,
            system_name TEXT,
            violation_type TEXT,
            severity TEXT,
            consensus_status TEXT DEFAULT 'pending',
            consensus_score REAL DEFAULT 0
        )
    """
    )
    conn.commit()
    conn.close()


def get_approved_violations() -> list:
    """Return violations that reached consensus approval (compat API)."""
    _ensure_compat_db()
    conn = sqlite3.connect(_COMPAT_DB)
    c = conn.cursor()
    c.execute(
        """SELECT violation_id, system_name, violation_type, severity, consensus_score
           FROM proposals WHERE consensus_status = 'approved'
           ORDER BY consensus_score DESC"""
    )
    rows = c.fetchall()
    conn.close()
    return [
        {
            "id": r[0],
            "system": r[1],
            "type": r[2],
            "severity": r[3],
            "consensus": r[4],
        }
        for r in rows
    ]


def get_consensus_status(violation_id: str) -> dict:
    """Return consensus status for a specific violation (compat API)."""
    _ensure_compat_db()
    conn = sqlite3.connect(_COMPAT_DB)
    c = conn.cursor()
    c.execute(
        "SELECT consensus_status, consensus_score FROM proposals WHERE violation_id = ?",
        (violation_id,),
    )
    row = c.fetchone()
    conn.close()
    if row:
        return {"status": row[0], "score": row[1]}
    return {"status": "unknown", "score": 0}


# ---------------------------------------------------------------------------
# Flask blueprint
# ---------------------------------------------------------------------------

_node: Optional[PBFTNode] = None

pbft_bp = Blueprint("pbft", __name__, url_prefix="/pbft")


def get_node() -> PBFTNode:
    assert _node is not None, "PBFTNode not initialised — call create_node() first"
    return _node


@pbft_bp.route("/request", methods=["POST"])
def bp_request():
    node = get_node()
    payload = flask_request.get_json(force=True)
    return jsonify(node.request(payload))


@pbft_bp.route("/pre-prepare", methods=["POST"])
def bp_pre_prepare():
    node = get_node()
    data = flask_request.get_json(force=True)
    return jsonify(node.handle_pre_prepare(data))


@pbft_bp.route("/prepare", methods=["POST"])
def bp_prepare():
    node = get_node()
    data = flask_request.get_json(force=True)
    return jsonify(node.handle_prepare(data))


@pbft_bp.route("/commit", methods=["POST"])
def bp_commit():
    node = get_node()
    data = flask_request.get_json(force=True)
    return jsonify(node.handle_commit(data))


@pbft_bp.route("/view-change", methods=["POST"])
def bp_view_change():
    node = get_node()
    data = flask_request.get_json(force=True)
    return jsonify(node.handle_view_change(data))


@pbft_bp.route("/new-view", methods=["POST"])
def bp_new_view():
    node = get_node()
    data = flask_request.get_json(force=True)
    return jsonify(node.handle_new_view(data))


@pbft_bp.route("/status", methods=["GET"])
def bp_status():
    node = get_node()
    return jsonify(node.status())


# ---------------------------------------------------------------------------
# Standalone mode
# ---------------------------------------------------------------------------


def create_node(
    node_id: str, peers: List[str], db_path: str = DB_PATH
) -> PBFTNode:
    """Create and register the module-level PBFTNode."""
    global _node
    _node = PBFTNode(node_id=node_id, peers=peers, db_path=db_path)
    return _node


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PBFT consensus node (standalone)")
    parser.add_argument("--port", type=int, default=6000, help="HTTP port")
    parser.add_argument(
        "--peers",
        type=str,
        default="",
        help="Comma-separated peer URLs, e.g. http://127.0.0.1:6001,http://127.0.0.1:6002",
    )
    parser.add_argument("--node-id", type=str, default=None, help="Node ID (defaults to http://127.0.0.1:<port>)")
    args = parser.parse_args()

    node_id = args.node_id or f"http://127.0.0.1:{args.port}"
    peers = [p.strip() for p in args.peers.split(",") if p.strip()]

    create_node(node_id=node_id, peers=peers)

    app = Flask(__name__)
    app.register_blueprint(pbft_bp)

    print(f"[PBFT] Node {node_id} starting on port {args.port}")
    print(f"[PBFT] Peers: {peers}")
    print(f"[PBFT] n={_node.n}, f={_node.f}, quorum={_node._quorum()}")
    app.run(host="0.0.0.0", port=args.port)
