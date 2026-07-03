Changed: the Knowledge Center now **grounds** the model instead of answering
before it. Removed the Tier-0 "$0, answer from the KB without an LLM"
short-circuit in `stream-chat.js` that served a retrieved doc section verbatim as
the reply. Keyword/TF-IDF retrieval has no comprehension, so it repeatedly dumped
off-topic or degenerate sections as "answers" (an empty ```bash fence for "what
can you do" #1778, for greetings, and for "is ollama running"), and each miss had
spawned another hand-written regex blocklist. Now the top KB section is injected
into the model's grounding context and every query is answered by the model,
which judges relevance, synthesizes a reply, cites the source, and can say "that's
not in the docs." The dead guards (`KB_ANSWER_MIN`, `wantsLiveData`, and the
greeting/capability regexes) are deleted with it.

Also fixed the index builder that produced those degenerate sections:
`split_sections` in `build_knowledge_index.py` is now fence-aware (a `#` comment
inside a ```` ``` ```` block is no longer parsed as a heading), and
`knowledge-router.js` filters prose-less sections out of retrieval via
`hasProse()`. Index rebuilt.
