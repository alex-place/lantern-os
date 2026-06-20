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
      profileId: "lantern-convergance",
      ollamaModel: process.env.CONVERGENCE_MODEL || "lantern-convergance",
      surfaces: ["eval", "promotion", "receipts", "task-loop"],
    },
    coder: {
      // Continually-trained local Σ₀ coding agent. LoRA fine-tuned on Claude
      // sessions; promoted by the continual-training loop + leaderboard.
      profileId: "lantern-sigma0-coder",
      ollamaModel: process.env.OLLAMA_MODEL || "lantern-sigma0-coder-v2",
      baseModel: "Qwen/Qwen2.5-Coder-3B-Instruct",
      trainingData: "models/lantern-sigma0-coder/training-data.jsonl",
      surfaces: ["autowork", "coding", "code-execution", "task-loop"],
      continualTraining: true,
    },
    coderLoop: {
      // Σ₀ Ouro DEEP coder (OURO_NATIVE=1 / deep serving mode): Ouro-1.4B + the Σ₀
      // LoRA adapter, served via the native Q-exit loop (src/sigma0/loop_lm.py),
      // NOT Ollama. Retrained on the execution-verified coding corpus (#781). The
      // adapter path is the promotion target every harness/loop reads by default;
      // override with OURO_ADAPTER.
      profileId: "lantern-sigma0-coder-loop",
      baseModel: "ByteDance/Ouro-1.4B",
      adapterPath: process.env.OURO_ADAPTER || "D:/lantern-train/ouro-sigma0-adapters/final",
      trainingData: "models/lantern-sigma0-coder/training-data.augmented.jsonl",
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
