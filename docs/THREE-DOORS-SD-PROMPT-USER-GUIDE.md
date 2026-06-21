---
author: Alex Place
created: 2026-06-11
updated: 2026-06-20
---

# Three Doors Kingdome: Stable Diffusion Prompt User Guide

**Version:** 1.0  
**Date:** 2026-06-11  
**Status:** Production-ready  
**Prompt Library:** `data/prompts/sd-prompt-library-kingdome-v1.json`  
**Canon Source:** `csf/ingest/2026-06-11-full-door-canon-v2.md`

---

## What Is This Guide?

This guide teaches you how to generate beautiful, canon-aligned images for the **Three Doors Kingdome** journey using **Stable Diffusion** running locally on your PC.

You'll learn:
- How to install and configure Stable Diffusion
- Where to find the Kingdome prompts
- How to generate images for each of the 7 stages
- How to customize images by archetype (Seeker, Healer, Explorer)
- How to integrate images into the Three Doors game
- How to troubleshoot common issues

**No cloud costs, no API keys needed** — everything runs on your machine.

---

## Quick Start (5 Minutes)

### You Have: 
- Windows/Mac/Linux PC with 8GB+ RAM
- An afternoon to set up

### You Want To Get:
- Images for all 7 Kingdome stages
- A workflow for generating new variations
- Optional: API integration with Three Doors game

### Steps:

1. **Download Automatic1111 WebUI** (recommended for ease)
   ```bash
   git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui.git
   cd stable-diffusion-webui
   ./webui-user.bat  # Windows
   # or bash webui.sh  # Mac/Linux
   ```

2. **Download DreamShaper XL 7.0 Model**
   - Visit: https://huggingface.co/Lykon/DreamShaper
   - Download: `DreamShaper_XL_1_0_safetensors.safetensors`
   - Place in: `stable-diffusion-webui/models/Stable-diffusion/`

3. **Download the VAE** (improves colors)
   - File: `sdxl_vae.safetensors`
   - Place in: `stable-diffusion-webui/models/VAE/`

4. **Get a Prompt**
   - Open: `data/prompts/sd-prompt-library-kingdome-v1.json`
   - Copy the `base_prompt` for any stage (0–6)
   - Example Stage 1 prompt below

5. **Generate Your First Image**
   - Open Automatic1111 WebUI: `http://127.0.0.1:7860`
   - Paste the prompt
   - Settings: Sampler = `DPM++ 2M Karras`, Steps = `28`, CFG = `7.5`
   - Click **Generate**

6. **Save the Image**
   ```
   data/images/kingdome/stage-1-12345.png
   ```

**Done!** You now have your first Kingdome image.

---

## Part 1: Installation & Setup

### A. Automatic1111 WebUI (Recommended)

**Why:** Easiest to use, works on all platforms, no coding required.

**Install on Windows:**

```powershell
# 1. Clone the repository
git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui.git
cd stable-diffusion-webui

# 2. Run the setup script
# On Windows, double-click: webui-user.bat
# Or from PowerShell:
.\webui-user.bat

# 3. Wait for "Running on http://127.0.0.1:7860"
# 4. Open that URL in your browser
```

**Install on Mac/Linux:**

```bash
# 1. Clone the repository
git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui.git
cd stable-diffusion-webui

# 2. Run setup
bash webui.sh

# 3. Open http://127.0.0.1:7860 in your browser
```

**First Run:**
- The script will download dependencies (~2 GB)
- Takes 5–15 minutes depending on internet speed
- After first run, startup is ~30 seconds

### B. ComfyUI Alternative

**Why:** More control, node-based workflow, faster inference.

**Install:**
```bash
# Clone ComfyUI
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI

# Install dependencies
pip install -r requirements.txt

# Run server
python main.py
```

**Then:**
- Download DreamShaper XL 7.0 to: `models/checkpoints/`
- Download VAE to: `models/vae/`
- Load via ComfyUI nodes (see **Part 4: Advanced Node Setup** below)

---

### C. Model Installation

#### Step 1: Download DreamShaper XL 7.0

**Why this model?** Best artistic quality, strong on fantasy/dreamscapes, consistent anatomy, optimized for the Kingdome canon.

**Download:**
1. Go to: https://huggingface.co/Lykon/DreamShaper
2. Click the **Files** tab
3. Download: `DreamShaper_XL_1_0_safetensors.safetensors` (~7 GB)
4. Save to: `stable-diffusion-webui/models/Stable-diffusion/`

**Verify:**
- Automatic1111 WebUI → **Model** dropdown should show `DreamShaper_XL_1_0_safetensors`

#### Step 2: Download VAE (Optional but Recommended)

**Why VAE?** Improves color saturation and details.

**Download:**
1. Same Hugging Face page
2. Look for: `sdxl_vae.safetensors`
3. Download and place in: `stable-diffusion-webui/models/VAE/`

**Use in Automatic1111:**
- Settings → VAE dropdown → select `sdxl_vae`

#### Alternative Models (If You Want Variety)

| Model | Best For | Size |
|-------|----------|------|
| **DreamShaper XL 7.0** | Fantasy, art, Kingdome | 7 GB |
| SDXL 1.0 base | Generic, reliable, versatile | 6 GB |
| Juggernaut XL | Photorealistic, detailed | 8 GB |
| RealismEngine SDXL | Photo-realistic variant | 7 GB |

**All models use the same prompts** — just switch in the dropdown.

---

## Part 2: Where To Find The Prompts

### The Prompt Library File

**Location:** `data/prompts/sd-prompt-library-kingdome-v1.json`

**What's inside:**
- 7 complete stage prompts (stages 0–6)
- Archetype modifiers (Seeker, Healer, Explorer)
- Recommended settings (sampler, steps, CFG)
- Canon alignment verification

**Quick View (Copy-Paste Ready):**

#### Stage 0: Garden at Beginning
```
A timeless garden where ancient moss covers crumbling stone lanterns 
casting warm golden light, roots twist through earth like glowing 
pathways, wisps of luminescent mist weave between wildflowers and 
forgotten fountains. The air feels thick with memory and beginning. 
Dreamlike, ethereal, illustrated storybook realism, soft watercolor 
undertones, gentle bokeh light.
```

#### Stage 1: Lucky Door (Today)
```
A sunlit field of four-leaf clovers bending under gentle rain, where 
quilted patchwork ruins of a forgotten cottage peek through verdant growth. 
Brass bells hang from twisted branches, chiming softly. A crown carved from 
driftwood rests among the flowers. Watercolor rain sparkles like luck itself. 
Cheerful, whimsical, contemporary folk art illustration style, layered 
translucent washes, golden hour afternoon light touching everything.
```

#### Stage 2: Tomorrow Door (Future)
```
An impossible reverse-tree spreads upward from earth, roots glowing with 
warm amber and jade, each branch segment a different unwritten future chapter, 
some burning with amber embers, others streaming with liquid light, Renaissance 
perspective geometry frames the whole composition. The roots are visible and 
strong. Epic scale, luminous oil painting style, soft focus at the edges, 
hopeful and expansive.
```

#### Stage 3: XP Door (Glitch Threshold)
```
A Windows XP desktop rendered as a surreal landscape, that nostalgic wrong-blue 
sky stretching infinite, pixelated corruption blooming like flowers, a monitor 
screen lying flat in the grass reflecting impossible geometry, liminal and 
disorienting, VHS grain and glitch artifacts, 2000s nostalgia, uncanny but oddly 
beautiful, subtle neon glows in the corrupted areas.
```

#### Stage 4: Xenon Starship (Convergence)
```
A crystalline geometric starship suspended between Earth and Mars at convergence, 
three sovereign lanterns of light arranged as a throne, the void studded with 
stars and mathematics, the ship is transparent, showing an impossible interior 
with towers of light, quantum realism, cosmic and transcendent, soft luminous 
whites, electric blues, and deep space purples.
```

#### Stage 5: Sigil City (Doors)
```
An awe-inspiring city of infinite doors stacked in fractal spirals, each door 
a portal with its own light, lanterns hung from impossible architecture, the 
King's throne visible at the center radiating sovereignty, the city glows with 
warm light, mathematical and organic at once, Renaissance perspective meeting 
cosmic scale, overwhelming in beauty.
```

#### Stage 6: Fog Door (Return)
```
A serene fog-covered threshold between sea and sky, the mist glows softly with 
memory and rest, an ornate gate stands peacefully, barely visible through the 
fog, the sound of gentle waves suggested by the composition, everything is soft 
and safe, watercolor and charcoal, peaceful and timeless, the perfect place to 
return to, to rest, to dream.
```

### Full JSON Format

For programmatic access (API integration), use the JSON file directly:

```json
{
  "metadata": {
    "version": "1.0",
    "created": "2026-06-11",
    "sd_model_recommendation": "DreamShaper XL 7.0"
  },
  "stages": [
    {
      "stage_number": 0,
      "stage_name": "Garden at Beginning",
      "base_prompt": "A timeless garden...",
      "archetype_modifiers": {
        "seeker": "with a solitary figure...",
        "healer": "with restorative light...",
        "explorer": "with hidden stone markers..."
      },
      "recommended_settings": {
        "sampler": "DPM++ 2M Karras",
        "steps": 28,
        "cfg_scale": 7.5
      }
    }
  ]
}
```

---

## Part 3: The 7 Stages & Settings

### Quick Reference Table

| Stage | Name | Mood | Best For |
|-------|------|------|----------|
| **0** | Garden at Beginning | Nostalgic, welcoming | Entry/return, dream start |
| **1** | Lucky Door (Today) | Warm, playful | Day-of journeys, luck moments |
| **2** | Tomorrow Door (Future) | Hopeful, expansive | Future paths, possibility |
| **3** | XP Door (Glitch) | Disorienting, uncanny | Memory glitches, breakthroughs |
| **4** | Xenon Starship | Transcendent, cosmic | Climax, convergence, synthesis |
| **5** | Sigil City | Awe-inspiring, meta | Door inventory, revelation |
| **6** | Fog Door (Return) | Peaceful, restful | Rest, return, closing |

### Recommended Settings for All Stages

| Setting | Value | Notes |
|---------|-------|-------|
| **Model** | DreamShaper XL 7.0 | Primary recommendation |
| **Sampler** | DPM++ 2M Karras | Best quality/speed balance |
| **Steps** | 20–32 | 20 for speed, 28 for quality, 32 for ultra |
| **CFG Scale** | 7.0–8.0 | 7.0 for looseness, 8.0 for adherence |
| **Seed** | -1 (random) | Use specific seed for reproducibility |
| **Aspect Ratio** | 16:9 (1024×576) | Default; see below for alternatives |
| **VAE** | sdxl_vae.safetensors | Improves colors |

### Aspect Ratio Options

All dimensions scale from a 768px base.

| Ratio | Dimensions | Use Case |
|-------|-----------|----------|
| **1:1** | 576×576 | Iconic single-stage portrait, square social media |
| **3:1** | 1152×384 | Cinematic ultra-wide, panoramic landscape |
| **5:7** | 411×576 | Portrait-tall, mobile-friendly |
| **9:16** | 324×576 | Vertical phone/story format |
| **16:9** | 1024×576 | **Recommended** — cinematic standard |

**To set aspect ratio in Automatic1111:**
1. Set **Width** and **Height** manually (e.g., 1024 and 576)
2. Or use **Aspect ratio** button if available

### Negative Prompt (Optional)

To exclude unwanted elements, add to the **Negative Prompt** field:

```
blurry, low quality, text, watermark, signature, deformed, ugly, 
bad anatomy, extra limbs, mangled hands, extra fingers, poorly drawn, 
out of focus, duplicate, muted colors
```

This helps the model avoid common artifacts.

---

## Part 4: Image Generation Workflow

### Workflow with Automatic1111 WebUI

#### Step-by-Step:

1. **Open Automatic1111**
   - URL: `http://127.0.0.1:7860`
   - Should see the WebUI with a large text box

2. **Select Your Model**
   - **Model** dropdown (top-left)
   - Choose: `DreamShaper_XL_1_0_safetensors`
   - Select VAE: `sdxl_vae.safetensors`

3. **Paste Your Prompt**
   - Click the large **Prompt** text box
   - Copy-paste one of the stage prompts from Part 2

4. **Set Generation Parameters**
   - **Sampler:** `DPM++ 2M Karras`
   - **Steps:** `28`
   - **CFG Scale:** `7.5`
   - **Width:** `1024`
   - **Height:** `576`
   - **Seed:** `-1` (for random)

5. **Add Negative Prompt (Optional)**
   - Click **Negative prompt** field
   - Paste the negative prompt from Part 3

6. **Generate**
   - Click the large **Generate** button
   - Wait 2–5 minutes (depends on steps and GPU)

7. **Save the Image**
   - Right-click the generated image
   - Save to: `data/images/kingdome/stage-[number]-[seed].png`

#### Example Output:

```
Generated: stage-1-4782193.png
Time taken: 3.2s
Seeds used: 4782193
Model: DreamShaper_XL_1_0_safetensors
```

### Workflow with ComfyUI

#### Node Setup:

1. **Load Checkpoint**
   - Create node: `Load Checkpoint`
   - Select: `DreamShaper_XL_1_0_safetensors`

2. **Add Prompt Text**
   - Create node: `CLIP Text Encode (Positive)`
   - Paste base prompt from Part 2
   - Connect to model's **CLIP**

3. **Sampler Configuration**
   - Create node: `KSampler`
   - Set:
     - **Sampler name:** `dpmpp_2m_karras`
     - **Steps:** `28`
     - **CFG:** `7.5`
     - **Seed:** `0` or `-1`
   - Connect: prompt → sampler

4. **VAE Decode**
   - Create node: `VAE Decode`
   - Connect sampler latent output

5. **Save Image**
   - Create node: `Save Image`
   - Connect VAE output
   - Set folder: `data/images/kingdome/`

6. **Queue Prompt**
   - Click **Queue Prompt** button
   - Watch progress

---

## Part 5: Archetype Modifiers (Personalization)

### What Are Archetypes?

The Three Doors game recognizes three player archetypes:
- **Seeker** — curious, searching, discovering
- **Healer** — caring, restorative, nurturing
- **Explorer** — adventurous, boundary-pushing, creative

Each archetype can customize the visual appearance of Kingdome stages.

### How to Use Modifiers

**Method 1: Copy-Paste (Easiest)**

1. Take the base prompt (e.g., Stage 1)
2. At the end, add the archetype modifier:

**Example — Stage 1 + Seeker:**
```
A sunlit field of four-leaf clovers bending under gentle rain, where 
quilted patchwork ruins of a forgotten cottage peek through verdant growth. 
Brass bells hang from twisted branches, chiming softly. A crown carved from 
driftwood rests among the flowers. Watercolor rain sparkles like luck itself. 
Cheerful, whimsical, contemporary folk art illustration style, layered 
translucent washes, golden hour afternoon light touching everything. 
With a figure kneeling to examine a four-leaf clover, eyes bright with discovery.
```

**Example — Stage 1 + Healer:**
```
[Base prompt as above]
With quilted fabric glowing warmly, bells arranged like healing instruments, 
flowers blooming in spirals of care.
```

**Example — Stage 1 + Explorer:**
```
[Base prompt as above]
With multiple clovers visible in distinct patterns, winding paths between them, 
hidden bells ringing throughout the field.
```

### All Archetype Modifiers by Stage

For each stage, grab the archetype modifier from the JSON file and append to the base prompt.

**Stage 0 (Garden):**
- **Seeker:** "with a solitary figure turning to face the garden for the first time, wonder in silhouette"
- **Healer:** "with restorative light pooling at the root network, stones worn smooth by countless gentle touches"
- **Explorer:** "with hidden stone markers peeking through moss, half-buried compass roses, trails branching into mist"

**Stage 1 (Lucky Door):**
- **Seeker:** "with a figure kneeling to examine a four-leaf clover, eyes bright with discovery"
- **Healer:** "with quilted fabric glowing warmly, bells arranged like healing instruments, flowers blooming in spirals of care"
- **Explorer:** "with multiple clovers visible in distinct patterns, winding paths between them, hidden bells ringing throughout the field"

**Stage 2 (Tomorrow Door):**
- **Seeker:** "with a figure standing at the base of the reverse-tree, looking upward at branching futures"
- **Healer:** "with amber light cascading down the tree like healing water, roots cradling seeds of growth"
- **Explorer:** "with multiple branching paths visible, each leading to a different future, the strongest paths glowing brighter"

**Stage 3 (XP Door):**
- **Seeker:** "with a lone figure navigating through the pixelated landscape, searching for a path forward"
- **Healer:** "with soft golden light breaking through the glitch, healing the corruption with warmth"
- **Explorer:** "with hidden glitch zones forming surprising paths, corruption revealing secret passages"

**Stage 4 (Xenon Starship):**
- **Seeker:** "with a figure approaching the light throne, reaching toward convergence"
- **Healer:** "with restorative lantern light radiating outward, healing the void between worlds"
- **Explorer:** "with multiple viewpoints visible, showing the cosmic scale of the convergence moment"

**Stage 5 (Sigil City):**
- **Seeker:** "with a figure standing before the city of doors, awestruck and ready"
- **Healer:** "with each door glowing with welcoming light, all thresholds open and safe"
- **Explorer:** "with infinite passages visible, each door revealing new territories, the architecture expanding in all directions"

**Stage 6 (Fog Door):**
- **Seeker:** "with a figure approaching the gate, drawn toward peaceful rest"
- **Healer:** "with the mist radiating safety and restoration, every element soft and cradling"
- **Explorer:** "with multiple gentle paths visible through the fog, leading to different kinds of rest"

### Tips for Archetype Customization

- Modifiers add 20–40 tokens to the prompt
- Use **one modifier per image** for best results
- Modifiers work with any aspect ratio
- Combine with custom seeds for consistency
- Different models may interpret modifiers differently (test to find your favorite)

---

## Part 6: Advanced: API Integration for the Game

### For Game Developers

The Three Doors game can integrate with local SD generation via a simple HTTP API.

### Proposed Endpoint

**Endpoint:** `POST /api/generate-image`

**Request Body:**
```json
{
  "stage_key": "lucky-door-present",
  "archetype": "seeker",
  "sampler": "DPM++ 2M Karras",
  "steps": 28,
  "cfg_scale": 7.5,
  "seed": -1,
  "aspect_ratio": "16:9"
}
```

**Response (Success):**
```json
{
  "status": "success",
  "image_path": "data/images/kingdome/stage-1-4782193.png",
  "image_url": "/images/kingdome/stage-1-4782193.png",
  "stage_number": 1,
  "seed": 4782193,
  "generation_time_seconds": 3.2,
  "model": "DreamShaper_XL_1_0_safetensors"
}
```

### Implementation Strategy

1. **Wrapper Service**
   - Create a Node.js service that calls Automatic1111 API
   - Endpoint: `POST /api/generate-image`
   - Forwards to: `http://127.0.0.1:7860/sdapi/v1/txt2img`

2. **Automatic1111 API Endpoint**
   - `POST http://127.0.0.1:7860/sdapi/v1/txt2img`
   - Payload structure:
     ```json
     {
       "prompt": "A timeless garden...",
       "negative_prompt": "blurry, low quality...",
       "steps": 28,
       "cfg_scale": 7.5,
       "width": 1024,
       "height": 576,
       "sampler_name": "DPM++ 2M Karras",
       "seed": -1
     }
     ```
   - Returns: base64-encoded PNG image

3. **Game Integration Flow**
   - Player chooses stage (0–6) and archetype (seeker/healer/explorer)
   - Game calls `/api/generate-image` with parameters
   - Service looks up stage prompt from JSON library
   - Service appends archetype modifier
   - Service calls Automatic1111 API
   - Image saved to `data/images/kingdome/stage-[number]-[seed].png`
   - URL returned to game UI

### Example Node.js Implementation

```javascript
// api/generate-image.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const AUTOMATIC1111_URL = 'http://127.0.0.1:7860/sdapi/v1/txt2img';
const PROMPT_LIBRARY = require('../data/prompts/sd-prompt-library-kingdome-v1.json');
const IMAGE_DIR = './data/images/kingdome/';

async function generateImage(req, res) {
  const { stage_key, archetype, steps = 28, cfg_scale = 7.5, seed = -1, aspect_ratio = '16:9' } = req.body;

  try {
    // Find stage in prompt library
    const stage = PROMPT_LIBRARY.stages.find(s => s.stage_key === stage_key);
    if (!stage) {
      return res.status(400).json({ error: 'Stage not found' });
    }

    // Build prompt with optional archetype modifier
    let prompt = stage.base_prompt;
    if (archetype && stage.archetype_modifiers[archetype]) {
      prompt += ' ' + stage.archetype_modifiers[archetype];
    }

    // Map aspect ratio to dimensions
    const aspectRatios = {
      '1:1': { width: 576, height: 576 },
      '3:1': { width: 1152, height: 384 },
      '16:9': { width: 1024, height: 576 },
      '5:7': { width: 411, height: 576 }
    };
    const { width, height } = aspectRatios[aspect_ratio] || aspectRatios['16:9'];

    // Call Automatic1111 API
    const response = await axios.post(AUTOMATIC1111_URL, {
      prompt,
      negative_prompt: 'blurry, low quality, text, watermark, signature, deformed, ugly',
      steps,
      cfg_scale,
      width,
      height,
      sampler_name: 'DPM++ 2M Karras',
      seed
    });

    // Save image
    const imageData = Buffer.from(response.data.images[0], 'base64');
    const filename = `stage-${stage.stage_number}-${seed || 'random'}.png`;
    const filepath = path.join(IMAGE_DIR, filename);
    
    fs.writeFileSync(filepath, imageData);

    // Return success response
    res.json({
      status: 'success',
      image_path: filepath,
      image_url: `/images/kingdome/${filename}`,
      stage_number: stage.stage_number,
      seed: response.data.info.seed || seed,
      generation_time_seconds: response.data.info.generation_time || 0,
      model: stage.recommended_settings.sampler
    });
  } catch (error) {
    console.error('Image generation error:', error.message);
    res.status(500).json({ error: 'Image generation failed' });
  }
}

module.exports = { generateImage };
```

---

## Part 7: Troubleshooting

### Installation & Setup Issues

#### "I can't download the model (Hugging Face is slow)"
**Solution:**
- Use a torrent client to download from Hugging Face via torrent
- Or use a mirror: `mirrors.huggingface.co`
- Or use an alternative model (SDXL 1.0 base is smaller at 6GB)

#### "webui-user.bat won't run"
**Solution (Windows):**
```powershell
# Run as administrator
# Then try:
python webui-user.py

# Or check if Python is installed:
python --version
```

#### "Port 7860 is already in use"
**Solution:**
```bash
# Kill the process using port 7860 (on Mac/Linux):
lsof -i :7860 | grep LISTEN | awk '{print $2}' | xargs kill -9

# On Windows, try a different port:
# Edit webui-user.bat, change --listen to --listen 127.0.0.1:7861
```

---

### Generation Quality Issues

#### "My image looks blurry or low-quality"

| Cause | Fix |
|-------|-----|
| Too few steps | Increase `steps` to 32–36 |
| CFG too low | Increase `cfg_scale` to 8.0–8.5 |
| Wrong sampler | Use `DPM++ 2M Karras` |
| Model issue | Ensure you're using DreamShaper XL 7.0 |
| VAE not loaded | Select `sdxl_vae.safetensors` in settings |

**Test command:**
```
Steps: 32
CFG Scale: 8.0
Sampler: DPM++ 2M Karras
VAE: sdxl_vae
```

#### "Colors are oversaturated"

**Solution:**
- Add to prompt: `muted colors, soft color grading, pastel tones`
- Or switch to SDXL 1.0 base model (less saturated by default)
- Or use `DPM++ 2M Karras` with slightly lower CFG (7.0 instead of 7.5)

#### "Bad hands, anatomy, or extra limbs"

**Solution:**
- Add to **Negative Prompt**: `bad anatomy, mangled hands, extra fingers, deformed limbs, extra arms`
- Reduce complexity: use a simpler archetype modifier
- Increase `steps` to 32–36

#### "I don't like the style of a particular stage"

**Solutions:**
1. Adjust the prompt before "Style hint" section:
   - Replace "dreamlike, ethereal" with "hyperrealistic, photographic"
   - Or "pixel art, 8-bit, retro"
2. Use a different model (Juggernaut XL for photorealism)
3. Add negative prompt: `cartoon, anime, unfinished`

---

### Model & File Issues

#### "Model not found / Model dropdown is empty"

**Solution:**
1. Verify download location: `stable-diffusion-webui/models/Stable-diffusion/`
2. File should be named: `DreamShaper_XL_1_0_safetensors.safetensors` (or similar)
3. Reload: Press F5 in the browser or restart Automatic1111
4. Check Automatic1111 console for errors

#### "VAE not showing in dropdown"

**Solution:**
1. Verify file: `stable-diffusion-webui/models/VAE/sdxl_vae.safetensors`
2. Restart Automatic1111
3. In WebUI settings, toggle **SD VAE** dropdown

#### "CUDA out of memory"

**Cause:** Your GPU doesn't have enough VRAM for the full model.

**Solutions (try in order):**
1. Lower resolution: Use 512×512 or 512×768 instead of 1024×576
2. Enable optimization: In Automatic1111 settings, set `Optimize Memory Usage` ON
3. Use lower step count: 20 instead of 28
4. Switch to CPU mode (slow but works): Set `--use-cpu all` in webui-user.bat

---

### Prompt & Archetype Issues

#### "Prompt is too long / token limit error"

**Solution:**
- Remove archetype modifier
- Simplify style hints (remove "watercolor undertones" if already said "watercolor")
- Use negative prompts instead of long positive descriptions
- Enable `fp16` mode in Automatic1111 for slightly longer prompts

#### "Archetype modifier doesn't seem to work"

**Solution:**
- Ensure modifier is properly appended (should start with "with")
- Example: `[base prompt] With a figure kneeling...`
- Try increasing `CFG scale` to 8.0–8.5 to enforce prompt adherence
- Use a higher step count (32+)

#### "I want to generate custom stages (not the 7 default ones)"

**How:**
1. Write your own prompt following the style of existing ones
2. Use stage prompts as templates
3. Keep 100–150 tokens for efficiency
4. Include: setting, mood, style hint, color palette
5. Use the same settings as Stage 1 (DPM++ 2M Karras, 28 steps, 7.5 CFG)

---

### Batch Generation

#### Generating Multiple Images at Once

**Automatic1111:**
1. In WebUI, find **Batch count** setting (top panel)
2. Set to `5` to generate 5 images in sequence
3. Helpful for testing variations

**Script Approach (PowerShell):**
```powershell
# Generate 7 images for all stages
$stages = @(0, 1, 2, 3, 4, 5, 6)
foreach ($stage in $stages) {
    # Load stage prompt from JSON
    $prompt = Get-Content "data/prompts/sd-prompt-library-kingdome-v1.json" | ConvertFrom-Json
    # Call generation endpoint (requires API wrapper)
    Invoke-WebRequest -Uri "http://127.0.0.1:7860/..." -Method POST
}
```

---

## Part 8: Gallery & Examples

### Sample Output Directory

Store generated images here:
```
data/images/kingdome/
├── stage-0-12345.png          (Garden at Beginning)
├── stage-1-12346.png          (Lucky Door, Seeker variant)
├── stage-1-seeker-678.png     (Same stage, different seed)
├── stage-2-12347.png          (Tomorrow Door)
├── stage-3-12348.png          (XP Door Glitch)
├── stage-4-12349.png          (Xenon Starship)
├── stage-5-12350.png          (Sigil City)
└── stage-6-12351.png          (Fog Door Return)
```

### Naming Convention

```
stage-[number]-[seed].png
```

Example: `stage-1-4782193.png`

### Image Pool Location

For Three Doors integration:
```
THREE_DOORS_IMAGE_POOL_DIR=D:\tmp\imagesandreports
```

Images in this directory are discoverable by the game.

---

## Part 9: Tips & Best Practices

### Getting Better Results

1. **Use Consistent Seeds**
   - If you like an image, note the seed
   - Use the same seed + slightly different prompts for variations
   - Seed = reproducibility

2. **Start Simple**
   - Generate one stage at a time
   - Use default settings (DPM++ 2M Karras, 28 steps, 7.5 CFG)
   - Adjust only one setting at a time

3. **Aspect Ratio Matters**
   - 16:9 is cinematic (good for scenes)
   - 1:1 is iconic (good for portraits)
   - 3:1 is panoramic (good for landscapes)
   - Don't use very extreme ratios (like 10:1) — SD struggles with them

4. **Archetype Modifiers Add Depth**
   - They introduce narrative elements
   - Use them when you want a specific mood or story
   - Skip them for abstract/landscape-focused scenes

5. **Test the Negative Prompt**
   - Generic negative: `blurry, low quality, text, watermark`
   - For hands: add `bad anatomy, mangled hands, extra fingers`
   - For style control: add `cartoon, anime` if you want photorealism

6. **Iterate & Save Seeds**
   - Always note the seed of images you like
   - Create variations by keeping seed but tweaking prompt slightly
   - Build a library of good seeds per stage

### Performance Tips

| Setting | Speed | Quality |
|---------|-------|---------|
| 20 steps | Fast (1–2s) | Lower quality |
| **28 steps** | **Balanced (3–4s)** | **Good** |
| 36 steps | Slower (5–7s) | Higher quality |
| 48 steps | Very slow (8–12s) | Maximum detail |

**Recommendation:** Start with 28 steps. Increase to 32–36 only if quality isn't satisfactory.

### Saving Seeds

Create a file: `data/images/kingdome/SEED_LOG.txt`

```
# Kingdome Seeds

## Stage 1 (Lucky Door)
- Seed 4782193: Good clover field, warm light
- Seed 4782194: Darker mood, more atmospheric
- Seed 4782195 + seeker: Best seeker version so far

## Stage 4 (Xenon)
- Seed 5123456: Good starship, clear convergence
```

---

## Part 10: Next Steps

### Immediate (This Session)

1. ✅ Install Automatic1111 WebUI
2. ✅ Download DreamShaper XL 7.0 + VAE
3. ✅ Generate test image for Stage 0 (Garden)
4. ✅ Save image to `data/images/kingdome/`
5. ✅ Test one archetype modifier (e.g., Seeker)

### Short-term (Optional)

1. Generate test images for all 7 stages (20–30 minutes)
2. Create a seed log of your favorite results
3. Experiment with different aspect ratios
4. Test alternative models (SDXL 1.0, Juggernaut XL)
5. Set up batch generation workflow

### Integration (For Game Developers)

1. Implement `/api/generate-image` endpoint (see Part 6)
2. Call from Three Doors game UI
3. Auto-select archetype based on player type
4. Cache generated images for quick replay
5. Track seed + metadata for reproducibility

### Advanced (Future)

1. Train a LoRA for consistent Kingdome style
2. Fine-tune prompts based on player feedback
3. Extend to other door families (Elephant Door, Raven, Sticker/Mixtape)
4. Implement img2img variations from existing images
5. Auto-generate gallery on game startup

---

## Quick Reference Card

### Essential Commands

**Automatic1111 Startup (Windows):**
```bash
cd stable-diffusion-webui
./webui-user.bat
```

**Automatic1111 Startup (Mac/Linux):**
```bash
cd stable-diffusion-webui
bash webui.sh
```

### Essential Settings

```
Model: DreamShaper_XL_1_0_safetensors
VAE: sdxl_vae.safetensors
Sampler: DPM++ 2M Karras
Steps: 28
CFG Scale: 7.5
Aspect: 1024×576 (16:9)
Seed: -1 (random)
Negative: blurry, low quality, text, watermark, deformed, ugly
```

### File Locations

| Item | Path |
|------|------|
| Prompts | `data/prompts/sd-prompt-library-kingdome-v1.json` |
| Generated Images | `data/images/kingdome/` |
| Automatic1111 | `stable-diffusion-webui/` |
| DreamShaper Model | `stable-diffusion-webui/models/Stable-diffusion/` |
| VAE | `stable-diffusion-webui/models/VAE/` |

### Helpful Links

- Automatic1111 GitHub: https://github.com/AUTOMATIC1111/stable-diffusion-webui
- DreamShaper Downloads: https://huggingface.co/Lykon/DreamShaper
- SDXL Documentation: https://huggingface.co/blog/sdxl
- Prompt Guide: https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/Features

---

## Support & Questions

### Documentation Files

- **Quick Reference:** `data/prompts/SD-QUICK-REFERENCE.md` (copy-paste prompts)
- **Technical Deep-Dive:** `data/prompts/SD-PROMPT-IMPLEMENTATION.md` (full settings guide)
- **Validation Report:** `data/prompts/VALIDATION-REPORT.md` (canon compliance)
- **This Guide:** `docs/THREE-DOORS-SD-PROMPT-USER-GUIDE.md` (you are here)

### Canon Reference

- **Door Canon:** `csf/ingest/2026-06-11-full-door-canon-v2.md`
- **Game Integration:** `docs/THREE-DOORS-ISSUES.md` (GitHub issues)

### If Something Doesn't Work

1. Check the **Troubleshooting** section (Part 7)
2. Read the implementation guide for model-specific tips
3. Verify file paths and model installation
4. Try default settings (DPM++ 2M Karras, 28 steps, 7.5 CFG)
5. Consult Automatic1111 GitHub issues (very helpful community)

---

## About This Guide

**Created:** 2026-06-11  
**Version:** 1.0  
**Status:** Production-ready  
**Audience:** Players, artists, game developers  
**License:** Use freely within this project  

**Related Files:**
- Prompt library: `data/prompts/sd-prompt-library-kingdome-v1.json`
- Implementation guide: `data/prompts/SD-PROMPT-IMPLEMENTATION.md`
- Validation report: `data/prompts/VALIDATION-REPORT.md`
- Canon source: `csf/ingest/2026-06-11-full-door-canon-v2.md`

**Next Update:** Post-Three-Doors integration (feedback from real usage)

---

**Happy dreaming! May your images flow like the Kingdome's golden light.** ✨
