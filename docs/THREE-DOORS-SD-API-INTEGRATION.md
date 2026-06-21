---
author: Alex Place
created: 2026-06-11
updated: 2026-06-20
---

# Three Doors Kingdome: Stable Diffusion API Integration Guide

**Version:** 1.0  
**Date:** 2026-06-11  
**Status:** Reference implementation  
**For:** Game developers integrating local SD image generation

---

## Overview

This guide provides complete code examples for integrating local Stable Diffusion image generation into the Three Doors Kingdome game.

**Architecture:**
1. **Automatic1111 SD WebUI** runs locally (`http://127.0.0.1:7860`)
2. **Node.js API wrapper** calls Automatic1111 API
3. **Three Doors game** calls the wrapper endpoint
4. **Images** saved to `data/images/kingdome/` and served to UI

---

## Part 1: Automatic1111 API Overview

### API Endpoint

**Base URL:** `http://127.0.0.1:7860/sdapi/v1/`

**Key Endpoints:**
- `GET /api/sd-models` — List available models
- `GET /api/samplers` — List available samplers
- `POST /api/txt2img` — Generate image from text prompt
- `POST /api/progress` — Check generation progress

### Text-to-Image Endpoint

**POST** `http://127.0.0.1:7860/sdapi/v1/txt2img`

**Request Body:**
```json
{
  "prompt": "A timeless garden...",
  "negative_prompt": "blurry, low quality, text, watermark",
  "steps": 28,
  "cfg_scale": 7.5,
  "width": 1024,
  "height": 576,
  "sampler_name": "DPM++ 2M Karras",
  "seed": -1,
  "batch_size": 1,
  "n_iter": 1
}
```

**Response:**
```json
{
  "images": ["base64_encoded_image_data"],
  "parameters": {
    "seed": 4782193,
    "steps": 28,
    "cfg_scale": 7.5
  },
  "info": {
    "seed": 4782193,
    "generation_time": 3.2,
    "sampler": "DPM++ 2M Karras"
  }
}
```

---

## Part 2: Node.js API Wrapper

### Module: `lib/sd-image-gen.js`

Create a new file: `apps/lantern-garage/lib/sd-image-gen.js`

```javascript
/**
 * Stable Diffusion Image Generation Wrapper
 * Integrates local Automatic1111 WebUI with Three Doors game
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const SD_API_URL = process.env.SD_API_URL || 'http://127.0.0.1:7860/sdapi/v1';
const IMAGE_DIR = path.join(__dirname, '../..', 'data', 'images', 'kingdome');
const PROMPT_LIBRARY_PATH = path.join(__dirname, '../..', 'data', 'prompts', 'sd-prompt-library-kingdome-v1.json');

// Ensure image directory exists
if (!fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

// Load prompt library
let promptLibrary = null;
function loadPromptLibrary() {
  if (!promptLibrary) {
    try {
      const data = fs.readFileSync(PROMPT_LIBRARY_PATH, 'utf8');
      promptLibrary = JSON.parse(data);
    } catch (error) {
      console.error('Failed to load prompt library:', error.message);
      promptLibrary = { stages: [] };
    }
  }
  return promptLibrary;
}

/**
 * Get stage data from prompt library
 * @param {string} stage_key - e.g., "garden-at-beginning"
 * @returns {object|null} - Stage object or null if not found
 */
function getStageData(stage_key) {
  const library = loadPromptLibrary();
  return library.stages.find(s => s.stage_key === stage_key) || null;
}

/**
 * Build full prompt with optional archetype modifier
 * @param {object} stage - Stage data from library
 * @param {string} archetype - Optional: "seeker", "healer", "explorer"
 * @returns {string} - Full prompt text
 */
function buildPrompt(stage, archetype = null) {
  let prompt = stage.base_prompt;
  
  if (archetype && stage.archetype_modifiers && stage.archetype_modifiers[archetype]) {
    prompt += ' ' + stage.archetype_modifiers[archetype];
  }
  
  return prompt;
}

/**
 * Map aspect ratio string to width/height
 * @param {string} aspect_ratio - e.g., "16:9", "1:1", "3:1"
 * @returns {object} - { width, height }
 */
function parseAspectRatio(aspect_ratio = '16:9') {
  const ratios = {
    '1:1': { width: 576, height: 576 },
    '3:1': { width: 1152, height: 384 },
    '5:7': { width: 411, height: 576 },
    '9:16': { width: 324, height: 576 },
    '16:9': { width: 1024, height: 576 }
  };
  
  return ratios[aspect_ratio] || ratios['16:9'];
}

/**
 * Generate image from stage key
 * @param {object} options - Generation options
 * @param {string} options.stage_key - Stage identifier (e.g., "lucky-door-present")
 * @param {string} options.archetype - Optional archetype modifier ("seeker", "healer", "explorer")
 * @param {number} options.steps - Number of generation steps (default: 28)
 * @param {number} options.cfg_scale - CFG scale (default: 7.5)
 * @param {number} options.seed - Random seed (default: -1 for random)
 * @param {string} options.aspect_ratio - Aspect ratio (default: "16:9")
 * @param {string} options.sampler - Sampler name (default: "DPM++ 2M Karras")
 * @returns {Promise<object>} - { status, image_path, image_url, seed, generation_time, ... }
 */
async function generateImage(options = {}) {
  const {
    stage_key,
    archetype = null,
    steps = 28,
    cfg_scale = 7.5,
    seed = -1,
    aspect_ratio = '16:9',
    sampler = 'DPM++ 2M Karras'
  } = options;

  try {
    // Validate stage
    if (!stage_key) {
      throw new Error('Missing required parameter: stage_key');
    }

    const stage = getStageData(stage_key);
    if (!stage) {
      throw new Error(`Stage not found: ${stage_key}`);
    }

    // Build prompt
    const prompt = buildPrompt(stage, archetype);
    const dimensions = parseAspectRatio(aspect_ratio);

    // Prepare SD API request
    const sdRequest = {
      prompt,
      negative_prompt: 'blurry, low quality, text, watermark, signature, deformed, ugly, bad anatomy, extra limbs, mangled hands, extra fingers',
      steps,
      cfg_scale,
      width: dimensions.width,
      height: dimensions.height,
      sampler_name: sampler,
      seed,
      batch_size: 1,
      n_iter: 1
    };

    console.log(`[SD] Generating image for stage: ${stage_key} (archetype: ${archetype || 'none'})`);
    console.log(`[SD] Prompt length: ${prompt.length} characters`);

    // Call Automatic1111 API
    const response = await axios.post(`${SD_API_URL}/txt2img`, sdRequest, {
      timeout: 600000 // 10 minute timeout
    });

    // Extract image data
    const imageBase64 = response.data.images[0];
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const actualSeed = response.data.info?.seed || seed;
    const generationTime = response.data.info?.generation_time || 0;

    // Save image to disk
    const filename = `stage-${stage.stage_number}-${actualSeed}.png`;
    const filepath = path.join(IMAGE_DIR, filename);
    fs.writeFileSync(filepath, imageBuffer);

    console.log(`[SD] Image saved: ${filepath}`);

    // Return success response
    return {
      status: 'success',
      image_path: filepath,
      image_url: `/images/kingdome/${filename}`,
      stage_key,
      stage_number: stage.stage_number,
      stage_name: stage.stage_name,
      archetype: archetype || null,
      seed: actualSeed,
      generation_time_seconds: generationTime,
      model: stage.recommended_settings?.sampler || sampler,
      dimensions: {
        width: dimensions.width,
        height: dimensions.height,
        aspect_ratio
      }
    };
  } catch (error) {
    console.error(`[SD] Error generating image: ${error.message}`);
    
    return {
      status: 'error',
      error: error.message,
      stage_key,
      archetype: options.archetype || null
    };
  }
}

/**
 * Get list of all stages in prompt library
 * @returns {array} - Array of stage metadata
 */
function getAvailableStages() {
  const library = loadPromptLibrary();
  return library.stages.map(s => ({
    stage_key: s.stage_key,
    stage_number: s.stage_number,
    stage_name: s.stage_name,
    mood: s.mood,
    archetypes: Object.keys(s.archetype_modifiers || {})
  }));
}

/**
 * Get stage details (full prompt, modifiers, settings)
 * @param {string} stage_key - Stage identifier
 * @returns {object|null} - Stage object or null
 */
function getStageDetails(stage_key) {
  return getStageData(stage_key);
}

/**
 * Batch generate images for all stages
 * @param {object} options - Generation options
 * @param {string} options.archetype - Optional archetype ("seeker", "healer", "explorer")
 * @param {number} options.steps - Generation steps
 * @param {number} options.cfg_scale - CFG scale
 * @returns {Promise<array>} - Array of generation results
 */
async function generateAllStages(options = {}) {
  const { archetype = null, steps = 28, cfg_scale = 7.5 } = options;
  const stages = getAvailableStages();
  const results = [];

  for (const stage of stages) {
    console.log(`[SD] Batch: Generating stage ${stage.stage_number}/${stages.length}...`);
    
    const result = await generateImage({
      stage_key: stage.stage_key,
      archetype,
      steps,
      cfg_scale,
      seed: -1
    });
    
    results.push(result);
    
    // Small delay between generations to prevent API flooding
    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

/**
 * Check if SD service is available
 * @returns {Promise<boolean>}
 */
async function isSDServiceAvailable() {
  try {
    await axios.get(`${SD_API_URL}/sd-models`, { timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get SD service status
 * @returns {Promise<object>} - { available, models_loaded, current_model, ... }
 */
async function getSDServiceStatus() {
  try {
    const modelsResponse = await axios.get(`${SD_API_URL}/sd-models`, { timeout: 5000 });
    
    return {
      available: true,
      api_url: SD_API_URL,
      models_loaded: modelsResponse.data?.length || 0,
      current_model: modelsResponse.data?.[0]?.title || 'Unknown'
    };
  } catch (error) {
    return {
      available: false,
      api_url: SD_API_URL,
      error: error.message
    };
  }
}

// Export functions
module.exports = {
  generateImage,
  generateAllStages,
  getAvailableStages,
  getStageDetails,
  getStageData,
  isSDServiceAvailable,
  getSDServiceStatus,
  IMAGE_DIR,
  SD_API_URL
};
```

---

## Part 3: Express Route Handler

### Add to `apps/lantern-garage/server.js`

```javascript
// ... existing imports ...
const sdImageGen = require('./lib/sd-image-gen');

// ... existing routes ...

/**
 * POST /api/generate-image
 * Generate Kingdome image from stage key and archetype
 */
if (pathname === '/api/generate-image' && method === 'POST') {
  let body = '';
  
  req.on('data', chunk => {
    body += chunk.toString();
  });
  
  req.on('end', async () => {
    try {
      const options = JSON.parse(body);
      
      // Validate required parameters
      if (!options.stage_key) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required parameter: stage_key' }));
        return;
      }
      
      // Generate image
      const result = await sdImageGen.generateImage(options);
      
      // Return result
      res.writeHead(result.status === 'success' ? 200 : 500, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error('Error handling /api/generate-image:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  return;
}

/**
 * GET /api/sd-status
 * Check Stable Diffusion service status
 */
if (pathname === '/api/sd-status' && method === 'GET') {
  (async () => {
    try {
      const status = await sdImageGen.getSDServiceStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  })();
  return;
}

/**
 * GET /api/sd-stages
 * List all available Kingdome stages
 */
if (pathname === '/api/sd-stages' && method === 'GET') {
  try {
    const stages = sdImageGen.getAvailableStages();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stages }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
  return;
}

/**
 * GET /api/sd-stage/:stage_key
 * Get details for a specific stage
 */
if (pathname.startsWith('/api/sd-stage/') && method === 'GET') {
  try {
    const stage_key = pathname.split('/').pop();
    const stage = sdImageGen.getStageDetails(stage_key);
    
    if (!stage) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Stage not found' }));
      return;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stage));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
  return;
}
```

---

## Part 4: Client-Side Usage (HTML/JavaScript)

### Example: Kingdome Image Generator UI

```html
<!-- In apps/lantern-garage/public/kingdome-generator.html -->

<!DOCTYPE html>
<html>
<head>
  <title>Kingdome Image Generator</title>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 50px auto; }
    .generator { background: #f9f5f0; padding: 20px; border-radius: 8px; }
    select, button { padding: 10px; margin: 5px; font-size: 16px; }
    button { background: #8b4513; color: white; border: none; cursor: pointer; }
    button:hover { background: #654321; }
    #preview { margin-top: 20px; text-align: center; }
    #preview img { max-width: 100%; border-radius: 8px; }
    #status { margin-top: 10px; padding: 10px; border-radius: 4px; }
    .success { background: #d4edda; color: #155724; }
    .error { background: #f8d7da; color: #721c24; }
    .loading { background: #d1ecf1; color: #0c5460; }
  </style>
</head>
<body>
  <h1>Kingdome Image Generator</h1>
  
  <div class="generator">
    <h2>Generate an Image</h2>
    
    <div>
      <label for="stage">Stage:</label>
      <select id="stage">
        <option value="">-- Select a stage --</option>
      </select>
    </div>
    
    <div>
      <label for="archetype">Archetype:</label>
      <select id="archetype">
        <option value="">None (base)</option>
        <option value="seeker">Seeker</option>
        <option value="healer">Healer</option>
        <option value="explorer">Explorer</option>
      </select>
    </div>
    
    <div>
      <label for="steps">Steps:</label>
      <input type="number" id="steps" value="28" min="20" max="50">
    </div>
    
    <div>
      <label for="cfg">CFG Scale:</label>
      <input type="number" id="cfg" value="7.5" min="1" max="20" step="0.5">
    </div>
    
    <button onclick="generateImage()">Generate Image</button>
    
    <div id="status"></div>
    
    <div id="preview">
      <img id="previewImage" style="display: none;">
      <p id="previewText"></p>
    </div>
  </div>

  <script>
    // Load available stages on page load
    window.addEventListener('load', async () => {
      try {
        const response = await fetch('/api/sd-stages');
        const data = await response.json();
        const stageSelect = document.getElementById('stage');
        
        data.stages.forEach(stage => {
          const option = document.createElement('option');
          option.value = stage.stage_key;
          option.textContent = `${stage.stage_number}. ${stage.stage_name}`;
          stageSelect.appendChild(option);
        });
      } catch (error) {
        showStatus('Error loading stages: ' + error.message, 'error');
      }
    });

    async function generateImage() {
      const stageKey = document.getElementById('stage').value;
      const archetype = document.getElementById('archetype').value;
      const steps = parseInt(document.getElementById('steps').value);
      const cfg = parseFloat(document.getElementById('cfg').value);
      
      if (!stageKey) {
        showStatus('Please select a stage', 'error');
        return;
      }
      
      showStatus('Generating image... This may take a few minutes.', 'loading');
      
      try {
        const response = await fetch('/api/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stage_key: stageKey,
            archetype: archetype || null,
            steps,
            cfg_scale: cfg,
            seed: -1
          })
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
          document.getElementById('previewImage').src = result.image_url;
          document.getElementById('previewImage').style.display = 'block';
          document.getElementById('previewText').textContent = 
            `Generated: ${result.stage_name} | ` +
            `Archetype: ${result.archetype || 'None'} | ` +
            `Seed: ${result.seed} | ` +
            `Time: ${result.generation_time_seconds.toFixed(1)}s`;
          showStatus('Image generated successfully!', 'success');
        } else {
          showStatus('Error: ' + result.error, 'error');
        }
      } catch (error) {
        showStatus('Error: ' + error.message, 'error');
      }
    }

    function showStatus(message, type = 'info') {
      const status = document.getElementById('status');
      status.textContent = message;
      status.className = type;
    }
  </script>
</body>
</html>
```

---

## Part 5: cURL Command Examples

### Test the API with cURL

#### Generate Image
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

#### Get Service Status
```bash
curl http://127.0.0.1:4177/api/sd-status
```

#### List Stages
```bash
curl http://127.0.0.1:4177/api/sd-stages
```

#### Get Stage Details
```bash
curl http://127.0.0.1:4177/api/sd-stage/lucky-door-present
```

---

## Part 6: Error Handling

### Common Errors & Responses

#### SD Service Not Available
```json
{
  "status": "error",
  "error": "connect ECONNREFUSED 127.0.0.1:7860",
  "stage_key": "garden-at-beginning"
}
```

**Fix:** Start Automatic1111 WebUI
```bash
cd stable-diffusion-webui && ./webui-user.bat
```

#### Invalid Stage Key
```json
{
  "status": "error",
  "error": "Stage not found: invalid-stage-key",
  "stage_key": "invalid-stage-key"
}
```

**Fix:** Use valid stage key (e.g., "garden-at-beginning", "lucky-door-present")

#### Insufficient Memory
```json
{
  "status": "error",
  "error": "CUDA out of memory",
  "stage_key": "garden-at-beginning"
}
```

**Fix:** Reduce steps or resolution, or enable memory optimization

---

## Part 7: Integration Best Practices

### 1. Start SD Service Before Game

The game should check if SD is available before attempting generation:

```javascript
async function initializeSDService() {
  const status = await fetch('/api/sd-status').then(r => r.json());
  
  if (!status.available) {
    console.warn('SD service not available. Image generation disabled.');
    // Disable image generation UI elements
    return false;
  }
  
  console.log('SD service ready:', status.current_model);
  return true;
}
```

### 2. Cache Generated Images

Don't regenerate the same image twice:

```javascript
const imageCache = new Map();

async function generateOrGetImage(stage_key, archetype, seed = -1) {
  const cacheKey = `${stage_key}:${archetype}:${seed}`;
  
  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }
  
  const result = await fetch('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({ stage_key, archetype, seed })
  }).then(r => r.json());
  
  imageCache.set(cacheKey, result);
  return result;
}
```

### 3. Seed Management

Store seeds for reproducible generation:

```javascript
// After successful generation, save to game state:
gameState.generatedImages[stage_key] = {
  archetype: result.archetype,
  seed: result.seed,
  timestamp: Date.now(),
  imageUrl: result.image_url
};

// Later, regenerate with same visual:
await generateOrGetImage(stage_key, archetype, savedSeed);
```

### 4. Progress Feedback

Show user feedback during long generations:

```javascript
async function generateWithProgress(stage_key, archetype) {
  const progressBar = document.getElementById('progress');
  progressBar.style.display = 'block';
  progressBar.textContent = 'Generating image... (this may take 3-5 minutes)';
  
  try {
    const result = await generateImage({ stage_key, archetype });
    progressBar.textContent = 'Done!';
  } finally {
    setTimeout(() => { progressBar.style.display = 'none'; }, 2000);
  }
}
```

---

## Part 8: Deployment Considerations

### Production Setup

**Local Deployment (Development):**
- SD runs on `http://127.0.0.1:7860` (same machine)
- Game also runs locally
- No network latency

**Network Deployment:**
- If SD and game are on different machines, update `SD_API_URL`:
  ```javascript
  const SD_API_URL = process.env.SD_API_URL || 'http://192.168.1.100:7860/sdapi/v1';
  ```

**Firewall/Security:**
- By default, Automatic1111 listens on `127.0.0.1:7860` (localhost only)
- For network access, start with: `./webui-user.bat --listen 0.0.0.0`
- **Warning:** This exposes SD to your network — secure it!

**Environment Variables:**
```bash
# .env
SD_API_URL=http://127.0.0.1:7860/sdapi/v1
IMAGE_POOL_DIR=data/images/kingdome
```

---

## Part 9: Testing

### Unit Test Example

```javascript
// test/sd-image-gen.test.js
const sdImageGen = require('../lib/sd-image-gen');

describe('SD Image Generation', () => {
  test('getAvailableStages should return array', () => {
    const stages = sdImageGen.getAvailableStages();
    expect(Array.isArray(stages)).toBe(true);
    expect(stages.length).toBe(7);
    expect(stages[0].stage_key).toBe('garden-at-beginning');
  });

  test('getStageData should find stage by key', () => {
    const stage = sdImageGen.getStageData('lucky-door-present');
    expect(stage).not.toBeNull();
    expect(stage.stage_number).toBe(1);
  });

  test('getStageData should return null for invalid key', () => {
    const stage = sdImageGen.getStageData('invalid-stage');
    expect(stage).toBeNull();
  });

  test('parseAspectRatio should convert string to dimensions', () => {
    const dims = sdImageGen.parseAspectRatio('16:9');
    expect(dims).toEqual({ width: 1024, height: 576 });
  });
});
```

---

## Summary

**Files Created:**
- `apps/lantern-garage/lib/sd-image-gen.js` — SD wrapper module
- Update `apps/lantern-garage/server.js` — Add API routes
- `apps/lantern-garage/public/kingdome-generator.html` — UI example

**Endpoints:**
- `POST /api/generate-image` — Generate an image
- `GET /api/sd-status` — Check service status
- `GET /api/sd-stages` — List all stages
- `GET /api/sd-stage/:stage_key` — Get stage details

**Environment:** 
- `SD_API_URL` — Automatic1111 API endpoint (default: `http://127.0.0.1:7860/sdapi/v1`)
- `IMAGE_DIR` — Output directory (default: `data/images/kingdome/`)

**Next Steps:**
1. Copy `sd-image-gen.js` to `apps/lantern-garage/lib/`
2. Add routes to `server.js`
3. Test with cURL examples
4. Integrate UI into Three Doors game
5. Deploy to production

---

**Created:** 2026-06-11  
**Version:** 1.0  
**Status:** Reference implementation, production-ready
