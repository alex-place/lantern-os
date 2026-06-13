"""
CSF Agent — autonomous issue scanner, embedder, scorer, and suggester.

Chain:
  scanner.py   → read GitHub issues into ranked CSF work list
  embedder.py  → map CSF symbolic vocab to float vectors
  scorer.py    → rank issues via tesseract axes + CSF embeddings
  suggester.py → write top-scored issue as csf/ingest/ task spec
"""
