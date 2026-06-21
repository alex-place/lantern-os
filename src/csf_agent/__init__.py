"""
CSF Agent — autonomous issue scanner, embedder, scorer, and suggester.

Chain:
  scanner.py   → read GitHub issues into ranked CSF work list
  embedder.py  → co-occurrence token-frequency vectors (NOT semantic embeddings)
  scorer.py    → rank issues via tesseract axes + CSF co-occurrence overlap
  suggester.py → write top-scored issue as csf/ingest/ task spec
"""
