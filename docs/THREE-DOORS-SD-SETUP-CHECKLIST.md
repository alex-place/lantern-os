---
author: Alex Place
created: 2026-06-11
updated: 2026-06-20
---

# Three Doors Kingdome: SD Setup Checklist

**Date:** 2026-06-11  
**Version:** 1.0  
**Reference:** `docs/THREE-DOORS-SD-PROMPT-USER-GUIDE.md`

---

## Pre-Flight Checklist

Use this checklist to verify your Stable Diffusion setup is complete and ready for image generation.

---

## Phase 1: Environment Setup

- [ ] **System Requirements Met**
  - OS: Windows 10+, macOS 11+, or Linux
  - RAM: 8GB minimum (16GB recommended)
  - GPU: Optional (generation is slower on CPU, but works)
  - Disk: 20GB free (for models + images)

- [ ] **Git Installed**
  ```bash
  git --version
  ```
  Should output: `git version X.XX.X`

- [ ] **Python 3.10+ Installed**
  ```bash
  python --version
  ```
  Should output: `Python 3.10.X` or newer

---

## Phase 2: Automatic1111 WebUI Installation

- [ ] **Clone Repository**
  ```bash
  git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui.git
  cd stable-diffusion-webui
  ```

- [ ] **Run Setup Script**
  - **Windows:** Double-click `webui-user.bat` or run `.\webui-user.bat`
  - **Mac/Linux:** Run `bash webui.sh`
  - Wait for: `Running on http://127.0.0.1:7860`

- [ ] **First Launch Successful**
  - Open browser: `http://127.0.0.1:7860`
  - You should see a WebUI with text boxes and buttons
  - **Note:** First run downloads dependencies (~2GB), takes 5–15 minutes

- [ ] **WebUI Shows "Ready"**
  - Startup should show: `API listening on http://127.0.0.1:7860`
  - Check browser console (F12) for errors — should be clean

---

## Phase 3: Model Installation (DreamShaper XL 7.0)

- [ ] **Model Downloaded**
  - File: `DreamShaper_XL_1_0_safetensors.safetensors` (~7GB)
  - From: https://huggingface.co/Lykon/DreamShaper
  - Status: ✅ Downloaded

- [ ] **Model Placed Correctly**
  - Location: `stable-diffusion-webui/models/Stable-diffusion/`
  - Path should be: `stable-diffusion-webui/models/Stable-diffusion/DreamShaper_XL_1_0_safetensors.safetensors`
  - Command to verify:
    ```bash
    ls stable-diffusion-webui/models/Stable-diffusion/ | grep -i dream
    ```

- [ ] **Model Appears in Dropdown**
  - Restart Automatic1111 (close + reopen)
  - Open WebUI
  - Top-left dropdown should show: `DreamShaper_XL_1_0_safetensors`
  - If not: press F5 to refresh, or check console for errors

---

## Phase 4: VAE Installation (Optional but Recommended)

- [ ] **VAE Downloaded**
  - File: `sdxl_vae.safetensors` (~300MB)
  - From: https://huggingface.co/Lykon/DreamShaper
  - Status: ✅ Downloaded

- [ ] **VAE Placed Correctly**
  - Location: `stable-diffusion-webui/models/VAE/`
  - Path should be: `stable-diffusion-webui/models/VAE/sdxl_vae.safetensors`
  - Command to verify:
    ```bash
    ls stable-diffusion-webui/models/VAE/ | grep -i sdxl
    ```

- [ ] **VAE Appears in Dropdown**
  - Restart Automatic1111
  - Open WebUI
  - Find **VAE** dropdown (Settings → VAE section)
  - Should show: `sdxl_vae`
  - If not: press F5 to refresh

---

## Phase 5: Prompt Library Setup

- [ ] **Prompt Library File Located**
  - Path: `data/prompts/sd-prompt-library-kingdome-v1.json`
  - Can open in: Text editor, VS Code, or any JSON viewer
  - Status: ✅ File exists

- [ ] **Prompt Library Readable**
  - Open file: `data/prompts/sd-prompt-library-kingdome-v1.json`
  - Search for: `"stage_name": "Garden at Beginning"`
  - Should find Stage 0 prompt
  - Status: ✅ Readable

- [ ] **Copy-Paste Prompts Available**
  - Alternative quick reference: `data/prompts/SD-QUICK-REFERENCE.md`
  - Open file
  - Find Stage 1 prompt ("A sunlit field of four-leaf clovers...")
  - Should be copyable as plain text
  - Status: ✅ Available

---

## Phase 6: Output Directory Setup

- [ ] **Image Output Directory Created**
  ```bash
  mkdir -p data/images/kingdome
  ```
  - Path: `data/images/kingdome/`
  - Status: ✅ Created

- [ ] **Directory is Writable**
  - Try creating a test file:
    ```bash
    echo "test" > data/images/kingdome/test.txt
    ```
  - Should succeed without permission errors
  - Clean up: `rm data/images/kingdome/test.txt`
  - Status: ✅ Writable

---

## Phase 7: First Image Generation Test

- [ ] **Open Automatic1111 WebUI**
  - URL: `http://127.0.0.1:7860`
  - Status: ✅ Page loads

- [ ] **Select Model**
  - Dropdown: `DreamShaper_XL_1_0_safetensors`
  - Status: ✅ Selected

- [ ] **Load VAE (Optional)**
  - Settings → VAE: `sdxl_vae`
  - Status: ✅ Selected

- [ ] **Paste Prompt**
  - Copy Stage 0 prompt from library
  - Paste into: **Prompt** text box
  - Status: ✅ Pasted

- [ ] **Set Generation Parameters**
  - Sampler: `DPM++ 2M Karras`
  - Steps: `28`
  - CFG Scale: `7.5`
  - Width: `1024`
  - Height: `576`
  - Seed: `-1`
  - Status: ✅ All set

- [ ] **Click Generate**
  - Button: **Generate**
  - Status: ✅ Clicked
  - Expected: Spinning wheel, progress bar, then image

- [ ] **Image Appears**
  - Wait 3–5 minutes (first generation may be slower)
  - Should see an image preview in the WebUI
  - Image should show a garden scene (ancient moss, lanterns, roots)
  - Status: ✅ Image generated

- [ ] **Save Generated Image**
  - Right-click image
  - Save as: `stage-0-[seed-number].png`
  - Location: `data/images/kingdome/`
  - Example: `stage-0-4782193.png`
  - Status: ✅ Saved

- [ ] **Verify File Saved**
  ```bash
  ls data/images/kingdome/
  ```
  - Should list your saved image
  - Status: ✅ Verified

---

## Phase 8: Archetype Modifier Test (Optional)

- [ ] **Copy Stage 1 Prompt**
  - Open prompt library
  - Find Stage 1 ("Lucky Door — Today")
  - Copy base prompt

- [ ] **Add Seeker Modifier**
  - Base prompt: "A sunlit field of four-leaf clovers..."
  - Append: "with a figure kneeling to examine a four-leaf clover, eyes bright with discovery."
  - Combined prompt should be ~200 tokens

- [ ] **Generate with Modifier**
  - Paste combined prompt into WebUI
  - Settings: Same as before (DPM++ 2M Karras, 28 steps, 7.5 CFG)
  - Click Generate
  - Wait for image

- [ ] **Image Shows Character**
  - Generated image should include a figure
  - Figure should be kneeling or examining something
  - Scene should still be the clover field
  - Status: ✅ Character-driven image generated

- [ ] **Save Variant Image**
  - Save as: `stage-1-seeker-[seed].png`
  - Location: `data/images/kingdome/`
  - Status: ✅ Saved

---

## Phase 9: Batch Generation Confidence Check

- [ ] **Generate All 7 Stages (Optional)**
  - Generate one image per stage (0–6)
  - Use default settings (DPM++ 2M Karras, 28 steps, 7.5 CFG)
  - Save each as: `stage-[number]-[seed].png`
  - Estimated time: 20–30 minutes total

- [ ] **Build Seed Log**
  - Create file: `data/images/kingdome/SEED_LOG.txt`
  - Log each seed + stage + notes:
    ```
    Stage 0: Seed 12345 - Good garden, warm light
    Stage 1: Seed 12346 - Great clover field, luck vibes
    ...
    ```
  - Status: ✅ Seed log created

- [ ] **All 7 Stages Generated**
  - Check: `data/images/kingdome/` contains 7+ images
  - Status: ✅ All stages complete

---

## Phase 10: Optional API Integration Setup

**Skip this phase if you're not integrating with the game yet.**

- [ ] **Automatic1111 API Enabled**
  - By default, API is enabled at: `http://127.0.0.1:7860/sdapi/v1/`
  - Test with curl (or browser):
    ```bash
    curl http://127.0.0.1:7860/api/sd-models
    ```
  - Should return JSON with available models
  - Status: ✅ API responding

- [ ] **Create API Wrapper** (Node.js)
  - File: `apps/lantern-garage/lib/sd-image-gen.js`
  - Implements: `generateKingdomeImage(stage_key, archetype, options)`
  - Returns: `{ image_path, image_url, seed, generation_time }`
  - Status: ✅ Wrapper created (see Part 10 of main guide)

- [ ] **Game Integration Route Created**
  - File: `apps/lantern-garage/server.js`
  - Route: `POST /api/generate-image`
  - Accepts: `{ stage_key, archetype, steps, cfg_scale, seed }`
  - Returns: Image URL + metadata
  - Status: ✅ Route added

- [ ] **Test API Endpoint**
  ```bash
  curl -X POST http://127.0.0.1:4177/api/generate-image \
    -H "Content-Type: application/json" \
    -d '{
      "stage_key": "garden-at-beginning",
      "archetype": "seeker",
      "steps": 28,
      "cfg_scale": 7.5,
      "seed": -1
    }'
  ```
  - Should return: `{ status: "success", image_url: "/images/kingdome/..." }`
  - Status: ✅ API working

---

## Phase 11: Troubleshooting Verification

**Only complete this phase if something went wrong.**

- [ ] **Model Not Found?**
  - Verify path: `stable-diffusion-webui/models/Stable-diffusion/DreamShaper_XL_1_0_safetensors.safetensors`
  - Restart Automatic1111
  - Check console for errors
  - Status: ✅ Fixed

- [ ] **Out of Memory?**
  - Try: Lower resolution (512×512 instead of 1024×576)
  - Or: Reduce steps to 20
  - Or: Enable optimization in settings
  - Status: ✅ Fixed

- [ ] **Slow Generation?**
  - Normal: 3–5 seconds per image with GPU
  - If slower: Check GPU usage (GPU monitor, Task Manager)
  - If on CPU: Generation is 10–30 minutes per image (normal)
  - Status: ✅ Acceptable

- [ ] **Bad Image Quality?**
  - Check: Are you using `DPM++ 2M Karras` sampler?
  - Check: Are steps ≥28?
  - Check: Is CFG 7.5 or higher?
  - Check: Is VAE loaded?
  - Try: Increase steps to 32–36
  - Status: ✅ Quality improved

---

## Summary Checklist

| Phase | Task | Status |
|-------|------|--------|
| 1 | Environment setup | ☐ |
| 2 | Automatic1111 installed | ☐ |
| 3 | DreamShaper model installed | ☐ |
| 4 | VAE installed (optional) | ☐ |
| 5 | Prompt library readable | ☐ |
| 6 | Output directory created | ☐ |
| 7 | First image generated successfully | ☐ |
| 8 | Archetype modifier tested | ☐ |
| 9 | All 7 stages generated (optional) | ☐ |
| 10 | API integration setup (optional) | ☐ |
| 11 | Troubleshooting completed (if needed) | ☐ |

---

## Final Verification

### You're ready if:

✅ Automatic1111 WebUI opens at `http://127.0.0.1:7860`  
✅ DreamShaper model appears in dropdown  
✅ You've generated at least one image successfully  
✅ Image saved to `data/images/kingdome/`  
✅ Prompt library is readable  
✅ Output directory exists and is writable  

### Next steps:

1. Read `docs/THREE-DOORS-SD-PROMPT-USER-GUIDE.md` for full guidance
2. Generate images for all 7 stages
3. Experiment with archetype modifiers
4. Build a seed library of favorite results
5. (Optional) Integrate with Three Doors game API

---

## Quick Reference: Essential Commands

**Start Automatic1111 (Windows):**
```bash
cd stable-diffusion-webui && .\webui-user.bat
```

**Start Automatic1111 (Mac/Linux):**
```bash
cd stable-diffusion-webui && bash webui.sh
```

**Test API:**
```bash
curl http://127.0.0.1:7860/api/sd-models
```

**Check generated images:**
```bash
ls -la data/images/kingdome/
```

---

**Created:** 2026-06-11  
**Status:** Production-ready  
**Reference:** `docs/THREE-DOORS-SD-PROMPT-USER-GUIDE.md`
