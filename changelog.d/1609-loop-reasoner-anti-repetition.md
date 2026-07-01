fix(chat): apply anti-repetition decode params on the loop-reasoner local Ollama path (#1609)

The loop-reasoner local call (`LOOP_REASONER=1`, coding/reasoning intent) was the
one Ollama call site that built its request body with no `options`, so the served
model ran with Ollama's weak defaults (`repeat_last_n=64`) and could spiral into
mid-generation multi-word/multi-language repetition. It now applies the same
`applyOllamaDecodeParams` (repeat_penalty 1.18, repeat_last_n 256, num_predict
ceiling, turn/template stop sequences) as every other local call site.
