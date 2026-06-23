fix(training): Kaggle dispatch slug mismatch + HF_HOME Linux crash

Two bugs caused every Kaggle training kernel to fail immediately:

1. Kernel title "Ouro Training — N steps" slugifies to ouro-training-N-steps,
   not ouro-training — Kaggle creates a brand-new kernel (version 1) every
   dispatch instead of updating the existing one.  Fix: use fixed title
   "Ouro Training" which resolves to the ouro-training slug.

2. train-qlora-ouro.py unconditionally sets HF_HOME=D:/hf-cache; on Kaggle
   (Linux) that path can't be created and all model downloads crash.
   Fix: guard with os.name == "nt"; also override in the generated Kaggle
   script with HF_HOME=/kaggle/working/hf-cache before the subprocess call.
