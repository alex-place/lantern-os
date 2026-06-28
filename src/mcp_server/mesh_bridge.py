"""
Lantern OS MCP Mesh Bridge
P2P mesh coordinator for MCP nodes. The master founder retains server
control; peers may donate resources (agent slots, compute time) to the mesh.

Architecture:
  - Founder node: the canonical MCP server (this instance) that controls
    topology and dispatches work.
  - Peer nodes: optional contributors that register their MCP endpoints and
    declare which resources they donate.
  - Mesh is opt-in; no peer is ever compelled to donate.
"""

from __future__ import annotations

import json
import time
import uuid
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field, asdict
from pathlib import Path

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

logger = logging.getLogger("lantern.mcp.mesh")

# ── Mesh State ──

@dataclass
class MeshPeer:
    peer_id: str
    name: str
    mcp_url: str  # e.g. http://host:port/sse
    messages_url: Optional[str] = None
    donated_resources: Dict[str, Any] = field(default_factory=dict)
    status: str = "offline"  # offline, online, busy
    # GPU compute donation capabilities
    gpu_count: Optional[int] = None
    gpu_memory_gb: Optional[float] = None
    compute_tier: Optional[str] = None # e.g., "A100", "V100", "RTX3090"
    training_capacity: Optional[int] = None # Number of concurrent training jobs
    evaluation_capacity: Optional[int] = None # Number of concurrent evaluation jobs
    last_seen: Optional[str] = None
    registered_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    founder_controlled: bool = False  # True for the canonical founder node

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class MeshBridge:
    """P2P mesh coordinator. Founder node manages the mesh graph."""

    def __init__(self, founder_url: str = "http://127.0.0.1:8771/sse"):
        self._peers: Dict[str, MeshPeer] = {}
        self._founder_url = founder_url
        self._founder_id = "founder"
        self._lock = asyncio.Lock()

        # Register the founder node automatically
        self._peers[self._founder_id] = MeshPeer(
            peer_id=self._founder_id,
            name="Lantern OS Founder",
            mcp_url=founder_url,
            status="online",
            last_seen=datetime.now(timezone.utc).isoformat(),
            founder_controlled=True,
            donated_resources={"agent_slots": 0, "compute_tier": "founder", "note": "canonical controller"},
        )

    # ── Peer management ──

    async def register_peer(
        self,
        name: str,
        mcp_url: str,
        messages_url: Optional[str] = None,
        receipts_endpoint: Optional[str] = None,
        gpu_count: Optional[int] = None,
        gpu_memory_gb: Optional[float] = None,
        compute_tier: Optional[str] = None,
        training_capacity: Optional[int] = None,
        evaluation_capacity: Optional[int] = None,
        donated_resources: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Register a new peer node (or re-register an existing one).

        If a peer with the same mcp_url already exists, updates its
        last_seen, status, and name in place rather than creating a
        duplicate entry with a new ID.
        """
        async with self._lock:
            # Dedup: look up existing peer by mcp_url before allocating a new ID
            existing = next(
                (p for p in self._peers.values() if p.mcp_url == mcp_url),
                None,
            )
            if existing is not None:
                existing.last_seen = datetime.now(timezone.utc).isoformat()
                existing.status = "online"
                existing.name = name
                if donated_resources is not None:
                    # Update GPU-related fields if provided
                    existing.gpu_count = gpu_count if gpu_count is not None else existing.gpu_count
                    existing.gpu_memory_gb = gpu_memory_gb if gpu_memory_gb is not None else existing.gpu_memory_gb
                    existing.compute_tier = compute_tier if compute_tier is not None else existing.compute_tier
                    existing.training_capacity = training_capacity if training_capacity is not None else existing.training_capacity
                    existing.evaluation_capacity = evaluation_capacity if evaluation_capacity is not None else existing.evaluation_capacity
                    existing.donated_resources = donated_resources
                logger.info("Mesh peer re-registered (updated): %s (%s)", name, existing.peer_id)
                return existing.to_dict()

            peer_id = str(uuid.uuid4())[:8]
            peer = MeshPeer(
                peer_id=peer_id,
                name=name,
                mcp_url=mcp_url,
                messages_url=messages_url or mcp_url.replace("/sse", "/messages"),
                receipts_endpoint=receipts_endpoint,
                donated_resources=donated_resources or {},
                status="online",
                last_seen=datetime.now(timezone.utc).isoformat(),
                gpu_count=gpu_count,
                gpu_memory_gb=gpu_memory_gb,
                compute_tier=compute_tier,
                training_capacity=training_capacity,
                evaluation_capacity=evaluation_capacity,
                founder_controlled=False,
            )
            self._peers[peer_id] = peer
            logger.info("Mesh peer registered: %s (%s) -> %s", name, peer_id, mcp_url)
            return peer.to_dict()

    async def remove_peer(self, peer_id: str) -> bool:
        """Remove a peer from the mesh. Founder cannot be removed."""
        async with self._lock:
            if peer_id == self._founder_id:
                return False
            if peer_id in self._peers:
                del self._peers[peer_id]
                logger.info("Mesh peer removed: %s", peer_id)
                return True
            return False

    async def update_donation(self, peer_id: str, resources: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update the resources a peer is willing to donate."""
        async with self._lock:
            peer = self._peers.get(peer_id)
            if not peer:
                return None
            # Explicitly update GPU-related fields if they are in the resources dict
            peer.gpu_count = resources.pop("gpu_count", peer.gpu_count)
            peer.gpu_memory_gb = resources.pop("gpu_memory_gb", peer.gpu_memory_gb)
            peer.compute_tier = resources.pop("compute_tier", peer.compute_tier)
            peer.training_capacity = resources.pop("training_capacity", peer.training_capacity)
            peer.evaluation_capacity = resources.pop("evaluation_capacity", peer.evaluation_capacity)
            peer.donated_resources = {**peer.donated_resources, **resources}
            peer.last_seen = datetime.now(timezone.utc).isoformat()
            logger.info("Mesh peer %s updated donation: %s", peer_id, resources)
            return peer.to_dict()

    async def heartbeat(self, peer_id: str) -> bool:
        """Record a heartbeat from a peer. Returns False if peer unknown."""
        async with self._lock:
            peer = self._peers.get(peer_id)
            if not peer:
                return False
            peer.last_seen = datetime.now(timezone.utc).isoformat()
            peer.status = "online"
            return True

    async def get_topology(self) -> Dict[str, Any]:
        """Return full mesh topology and aggregate donated resources."""
        async with self._lock:
            peers = [p.to_dict() for p in self._peers.values()]
            total_donated: Dict[str, Any] = {}
            for p in self._peers.values():
                if p.founder_controlled:
                    continue
                for key, value in p.donated_resources.items():
                    if isinstance(value, (int, float)):
                        total_donated[key] = total_donated.get(key, 0) + value
                    else:
                        total_donated[key] = value

            return {
                "founder_id": self._founder_id,
                "founder_url": self._founder_url,
                "peer_count": len(self._peers),
                "donor_count": sum(1 for p in self._peers.values() if not p.founder_controlled and p.donated_resources),
                "peers": peers,
                "aggregate_donated_resources": total_donated,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

    async def list_available_resources(self) -> List[Dict[str, Any]]:
        """List all peers that have donated resources and are online."""
        async with self._lock:
            return [
                {
                    "peer_id": p.peer_id,
                    "name": p.name,
                    "mcp_url": p.mcp_url,
                    "resources": p.donated_resources,
                    "gpu_count": p.gpu_count,
                    "gpu_memory_gb": p.gpu_memory_gb,
                    "compute_tier": p.compute_tier,
                    "training_capacity": p.training_capacity,
                    "evaluation_capacity": p.evaluation_capacity,
                    "receipts_endpoint": p.receipts_endpoint,
                    "status": p.status,
                }
                for p in self._peers.values()
                if not p.founder_controlled and p.donated_resources and p.status == "online"
            ]

    async def dispatch_to_peer(self, peer_id: str, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Dispatch a tool call to a peer MCP server (proxy)."""
        if not HTTPX_AVAILABLE:
            return {"error": "httpx not installed; cannot proxy to peer"}

        peer = self._peers.get(peer_id)
        if not peer:
            return {"error": f"Peer {peer_id} not found"}
        if peer.founder_controlled:
            return {"error": "Cannot dispatch to founder via mesh proxy; use local tools directly"}

        messages_url = peer.messages_url or peer.mcp_url.replace("/sse", "/messages")
        payload = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4())[:8],
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(messages_url, json=payload)
                resp.raise_for_status()
                return resp.json()
        except Exception as exc:
            logger.warning("Mesh dispatch to %s failed: %s", peer_id, exc)
            return {"error": str(exc), "peer_id": peer_id}

    # ── Founder controls ──

    async def set_peer_status(self, peer_id: str, status: str) -> Optional[Dict[str, Any]]:
        """Founder-only: set a peer's status (online, offline, busy)."""
        async with self._lock:
            peer = self._peers.get(peer_id)
            if not peer or peer.founder_controlled:
                return None
            peer.status = status
            peer.last_seen = datetime.now(timezone.utc).isoformat()
            return peer.to_dict()

    async def prune_stale_peers(self, max_age_seconds: float = 300.0) -> int:
        """Remove peers that have not sent a heartbeat in a while."""
        now = datetime.now(timezone.utc)
        removed = 0
        async with self._lock:
            stale = []
            for peer_id, peer in list(self._peers.items()):
                if peer.founder_controlled:
                    continue
                if peer.last_seen:
                    last = datetime.fromisoformat(peer.last_seen)
                    if (now - last).total_seconds() > max_age_seconds:
                        stale.append(peer_id)
            for peer_id in stale:
                del self._peers[peer_id]
                removed += 1
                logger.info("Pruned stale mesh peer: %s", peer_id)
        return removed


# Singleton mesh instance
_mesh_bridge: Optional[MeshBridge] = None


def get_mesh_bridge(founder_url: Optional[str] = None) -> MeshBridge:
    global _mesh_bridge
    if _mesh_bridge is None:
        _mesh_bridge = MeshBridge(founder_url or "http://127.0.0.1:8771/sse")
    return _mesh_bridge
