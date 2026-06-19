import os, sys, time
os.environ.setdefault("HF_HOME", "D:/hf-cache")
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
MODEL = sys.argv[1] if len(sys.argv) > 1 else "ByteDance/Ouro-1.4B-Thinking"
print(f"loading {MODEL} (cuda={torch.cuda.is_available()})...", flush=True)
t = time.time()
tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(MODEL, trust_remote_code=True, torch_dtype=torch.float16, device_map="auto")
print(f"loaded in {time.time()-t:.0f}s. config recurrent steps:",
      getattr(model.config, "total_ut_steps", getattr(model.config, "num_recurrent_steps", "?")), flush=True)
msgs = [{"role": "user", "content": "In one sentence, what is a looped language model?"}]
ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to(model.device)
t = time.time()
out = model.generate(ids, max_new_tokens=80, do_sample=False)
print("GEN:", tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True))
print(f"gen {time.time()-t:.0f}s")
