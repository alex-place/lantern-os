"""
CSF Agent — autonomous issue scanner, co-occurrence vectorizer, scorer, and suggester.

Chain:
  scanner.py   → read GitHub issues into ranked CSF work list
  embedder.py  → CSFCooccurrenceVectorizer (vocab overlap, NOT semantic embedding — #937)
  scorer.py    → rank issues via tesseract axes + co-occurrence similarity
  suggester.py → write top-scored issue as csf/ingest/ task spec
"""
