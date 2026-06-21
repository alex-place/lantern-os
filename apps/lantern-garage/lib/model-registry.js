/**
 * Canonical Model Registry for Lantern OS
 * Maps model profiles to Ollama models and surface usage
 */

// Model registry with configurations for all surfaces
module.exports = {
  text: {
    keystone: {
      profileId: "keystone-ft",
      ftAgentId: "agent_01XLCumJKAJzNtUiB1FQTWrT",
      memoryStoreId: "memstore_01WYD6jnTDjbCDGPSHGWPeqx",
      baseModel: "claude-haiku-4-5-20251001",
      trainingData: "data/training/haiku-ft-pairs.jsonl",
      surfaces: ["dream-chat", "orchestration", "code-execution"],
    },
    dream: {
      profileId: "lantern-csf-dream",
      ollamaModel: process.env.DREAMCHAT_MODEL || "lantern-csf-dream",
      surfaces: ["dream-chat", "dream-journal", "three-doors"],
    },
    pcsf: {
      profileId: "lantern-pcsf",
      ollamaModel: process.env.PCSF_MODEL || "lantern-pcsf",
      surfaces: ["provider-routing", "privacy", "receipts"],
    },
    convergance: {
      // #811: Ollama sunset — convergance surface now served by ouro:latest on :11434.
      // Override with CONVERGENCE_MODEL if a dedicated model is later promoted.
      profileId: "lantern-convergance",
      ollamaModel: process.env.CONVERGENCE_MODEL || "ouro:latest",
      surfaces: ["eval", "promotion", "receipts", "task-loop"],
    },
    coder: {
      // Σ₀ coding agent (fast cached serving). The legacy Qwen2.5-Coder-3B
      // `lantern-sigma0-coder-v2` is DEPRECATED (Ollama sunset #811/#823): its Qwen
      // weights + Ollama deployment were removed. The coder surface now serves the
      // Σ₀ Ouro coder via ouro_serve.py (ouro:latest on :11434); ouro_serve still
      // accepts the old name for back-compat. See docs/SIGMA0-OURO-CODER.md (the single
      // source of truth — then/now + loop mechanism). DEEP loop variant: `coderLoop`.
      profileId: "lantern-sigma0-coder",
      ollamaModel: process.env.OLLAMA_MODEL || "ouro:latest",
      baseModel: "ByteDance/Ouro-1.4B",  // legacy base was Qwen/Qwen2.5-Coder-3B-Instruct
      trainingData: "models/lantern-sigma0-coder/training-data.jsonl",
      surfaces: ["autowork", "coding", "code-execution", "task-loop"],
      continualTraining: true,
    },
    coderLoop: {
      // Σ₀ Ouro DEEP coder (OURO_NATIVE=1 / deep serving mode): Ouro-1.4B + the Σ₀
      // LoRA adapter, served via the native Q-exit loop (src/sigma0/loop_lm.py),
      // NOT Ollama. Retrained on the execution-verified coding corpus (#781). The
      // adapter path is the promotion target every harness/loop reads by default;
      // override with OURO_ADAPTER env.
      // Adapter default points at the trained, on-disk `/final` (verified 2026-06-20:
      // 57.92 MB, base ByteDance/Ouro-1.4B, LoRA r=16/α=32). The `/v2` promotion target
      // is not trained yet — retrain with scripts/prepare_coding_train_data.py +
      // train-qlora-ouro.py --out D:/lantern-train/ouro-sigma0-adapters/v2, then repoint.
      profileId: "lantern-sigma0-coder-loop",
      baseModel: "ByteDance/Ouro-1.4B",
      adapterPath: process.env.OURO_ADAPTER || "D:/lantern-train/ouro-sigma0-adapters/final",
      trainingData: "models/lantern-sigma0-coder/training-data.jsonl",
      trainingScript: "scripts/train-qlora-ouro.py",
      prepScript: "scripts/prepare_coding_train_data.py",
      surfaces: ["deep-reasoning", "coding", "task-loop"],
      continualTraining: true,
    },
  },
  image: {
    dream: {
      modelId: "lantern-csf-dream-image",
      adapterPath:
        process.env.LANTERN_IMAGE_LORA ||
        "models/csf-image/checkpoints/lantern-door-lora-final.safetensors",
      surfaces: ["dream-journal", "three-doors"],
      status: "hold-pending-validation",
    },
  },
};
