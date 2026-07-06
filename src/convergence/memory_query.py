"""CLI wrapper for Memory.query() — called by Node.js routes.

Accepts pattern + filters, returns JSON array of matching MemoryEntry objects.
Enables reasoners (dream-chat, router, kalshi-suggest) to query persistent memory.

wq-008: Memory query interface for all reasoners.
"""

import sys
import json
import argparse
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from convergence.memory import MemoryStore


def main():
    parser = argparse.ArgumentParser(description="Query Memory store")
    parser.add_argument("--pattern", default="", help="Text pattern to search")
    parser.add_argument("--min-confidence", type=float, default=0.5, help="Minimum confidence threshold")
    parser.add_argument("--order-by", choices=["timestamp", "confidence"], help="Sort by field")
    parser.add_argument("--source-filter", help="Filter by source")
    parser.add_argument("--limit", type=int, default=10, help="Max results")
    parser.add_argument("--memory-dir", default="data",
                        help="Directory the MemoryStore reads (default: data). Lets the Node seam "
                             "and tests point at an isolated store; #2081.")

    args = parser.parse_args()

    # Initialize Memory store (reads from --memory-dir, default data/)
    memory = MemoryStore(memory_dir=args.memory_dir)

    # Execute query
    results = memory.query(
        pattern=args.pattern,
        min_confidence=args.min_confidence,
        order_by=args.order_by,
        limit=args.limit,
        source_filter=args.source_filter,
    )

    # Convert MemoryEntry objects to JSON
    json_results = [
        {
            "id": entry.id,
            "timestamp": entry.timestamp.isoformat(),
            "source": entry.source,
            "confidence": entry.confidence,
            "content": entry.content,
            "evidence_ids": entry.evidence_ids,
        }
        for entry in results
    ]

    # Output JSON to stdout for Node to parse
    print(json.dumps(json_results, indent=2))


if __name__ == "__main__":
    main()
