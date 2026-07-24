// Lanterns V9 Safe Zone Detector
// Detects and preserves critical regions in video (facecam, HUD, minimap, killfeed)
// Ensures these regions never get cropped during editing/export

// ============================================================================
// DATA STRUCTURES
// ============================================================================

class SafeZone {
  constructor(type, bounds, confidence = 1.0) {
    this.type = type; // "facecam" | "hud" | "minimap" | "killfeed" | "custom"
    this.bounds = bounds; // { x, y, width, height } in pixels (0-1 normalized)
    this.confidence = confidence; // 0-1
    this.detectedAt = new Date().toISOString();
  }

  // Convert bounds to top-left, top-right, bottom-left, bottom-right corners
  getCorners() {
    return {
      topLeft: { x: this.bounds.x, y: this.bounds.y },
      topRight: { x: this.bounds.x + this.bounds.width, y: this.bounds.y },
      bottomLeft: { x: this.bounds.x, y: this.bounds.y + this.bounds.height },
      bottomRight: {
        x: this.bounds.x + this.bounds.width,
        y: this.bounds.y + this.bounds.height,
      },
    };
  }

  toJSON() {
    return {
      type: this.type,
      bounds: this.bounds,
      confidence: Number(this.confidence.toFixed(2)),
      detectedAt: this.detectedAt,
    };
  }
}

class SafeZoneMap {
  constructor(videoWidth, videoHeight) {
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;
    this.safeZones = [];
    this.detectedAt = new Date().toISOString();
  }

  addZone(zone) {
    this.safeZones.push(zone);
  }

  // Calculate safe crop regions that don't intersect any safe zones
  calculateSafeCropRegions() {
    const regions = [];

    // Default: full frame
    const fullFrame = {
      x: 0,
      y: 0,
      width: 1.0,
      height: 1.0,
      conflicts: [],
    };

    // Check intersections with safe zones
    for (const zone of this.safeZones) {
      fullFrame.conflicts.push({
        zoneType: zone.type,
        bounds: zone.bounds,
      });
    }

    regions.push(fullFrame);

    // Generate alternative crops that avoid safe zones
    regions.push(this.generateVerticalCrop());
    regions.push(this.generateHorizontalCrop());
    regions.push(this.generateSquareCrop());

    return regions.filter((r) => this.isValidCrop(r));
  }

  generateVerticalCrop() {
    // Standard mobile vertical (9:16)
    return {
      x: 0.125,
      y: 0,
      width: 0.75,
      height: 1.0,
      format: "mobile-vertical",
      conflicts: this.safeZones
        .filter((z) => z.bounds.x >= 0.125 && z.bounds.x + z.bounds.width <= 0.875)
        .map((z) => z.type),
    };
  }

  generateHorizontalCrop() {
    // Widescreen horizontal (16:9)
    return {
      x: 0,
      y: 0.15625,
      width: 1.0,
      height: 0.6875,
      format: "widescreen-horizontal",
      conflicts: this.safeZones
        .filter((z) => z.bounds.y >= 0.15625 && z.bounds.y + z.bounds.height <= 0.84375)
        .map((z) => z.type),
    };
  }

  generateSquareCrop() {
    // Square crop (1:1) centered
    const size = Math.min(1.0, 1.0);
    return {
      x: (1.0 - size) / 2,
      y: (1.0 - size) / 2,
      width: size,
      height: size,
      format: "square",
      conflicts: this.safeZones
        .filter(
          (z) =>
            z.bounds.x >= (1.0 - size) / 2 &&
            z.bounds.x + z.bounds.width <= (1.0 - size) / 2 + size &&
            z.bounds.y >= (1.0 - size) / 2 &&
            z.bounds.y + z.bounds.height <= (1.0 - size) / 2 + size
        )
        .map((z) => z.type),
    };
  }

  isValidCrop(crop) {
    // Valid if:
    // 1. Bounds are within 0-1
    // 2. Width and height are positive
    // 3. No critical zones in conflicts (facecam, hud are critical)
    if (crop.x < 0 || crop.x + crop.width > 1.0) return false;
    if (crop.y < 0 || crop.y + crop.height > 1.0) return false;
    if (crop.width <= 0 || crop.height <= 0) return false;

    const criticalConflicts = crop.conflicts?.filter((c) =>
      c === "facecam" || c === "hud" || c === "killfeed"
    ) || [];

    return criticalConflicts.length === 0;
  }

  // Get recommended safe frame padding (pixels to avoid safe zones)
  getSafePadding() {
    if (this.safeZones.length === 0) {
      return { top: 0, bottom: 0, left: 0, right: 0 };
    }

    const bounds = this.safeZones.map((z) => z.bounds);
    let top = Infinity,
      bottom = -Infinity,
      left = Infinity,
      right = -Infinity;

    for (const b of bounds) {
      top = Math.min(top, b.y);
      bottom = Math.max(bottom, b.y + b.height);
      left = Math.min(left, b.x);
      right = Math.max(right, b.x + b.width);
    }

    return {
      top: top * this.videoHeight,
      bottom: (1 - bottom) * this.videoHeight,
      left: left * this.videoWidth,
      right: (1 - right) * this.videoWidth,
    };
  }

  toJSON() {
    return {
      videoWidth: this.videoWidth,
      videoHeight: this.videoHeight,
      safeZones: this.safeZones.map((z) => z.toJSON()),
      safeCropRegions: this.calculateSafeCropRegions(),
      safePadding: this.getSafePadding(),
      detectedAt: this.detectedAt,
    };
  }
}

// ============================================================================
// DETECTION FUNCTIONS
// ============================================================================

async function detectSafeZones(videoPath, frameData) {
  // For now: hardcoded patterns based on common gaming layouts
  // In production: use ML model or optical flow analysis
  // See PATTERNS below for common game UIs

  const zones = [];

  // Detect facecam (usually top-right or bottom-right corner, 15-25% of screen)
  const facecamChance = detectFacecam(frameData);
  if (facecamChance > 0.6) {
    zones.push(
      new SafeZone(
        "facecam",
        { x: 0.75, y: 0.0, width: 0.25, height: 0.25 }, // Top-right default
        facecamChance
      )
    );
  }

  // Detect HUD elements (bottom, top, or sides - typically 10-20% of screen)
  const hudZones = detectHUD(frameData);
  zones.push(...hudZones);

  // Detect minimap (usually top-right or bottom-right, 10-15%)
  const minimapChance = detectMinimap(frameData);
  if (minimapChance > 0.5) {
    zones.push(
      new SafeZone(
        "minimap",
        { x: 0.85, y: 0.75, width: 0.15, height: 0.25 }, // Bottom-right default
        minimapChance
      )
    );
  }

  // Detect killfeed (usually right or top-right, 5-10%)
  const killfeedChance = detectKillfeed(frameData);
  if (killfeedChance > 0.5) {
    zones.push(
      new SafeZone(
        "killfeed",
        { x: 0.85, y: 0.0, width: 0.15, height: 0.3 }, // Top-right default
        killfeedChance
      )
    );
  }

  // Bug fix (V10): the detected zones were previously discarded — the returned
  // map was constructed empty. Add the detected zones so callers actually
  // receive them.
  const map = new SafeZoneMap(frameData.width, frameData.height);
  for (const zone of zones) {
    map.addZone(zone);
  }
  return map;
}

// ============================================================================
// DETECTION HEURISTICS
// ============================================================================

function detectFacecam(frameData) {
  // Look for:
  // 1. Round or square high-contrast region
  // 2. Skin tones
  // 3. Movement patterns (face)

  // Simplified: check for specific pixel patterns common to facecams
  // In production: use ML model or template matching

  if (!frameData.pixels) return 0;

  const cornerRegions = {
    topRight: getRegionPixels(frameData, 0.75, 0.0, 0.25, 0.25),
    bottomRight: getRegionPixels(frameData, 0.75, 0.75, 0.25, 0.25),
    topLeft: getRegionPixels(frameData, 0.0, 0.0, 0.25, 0.25),
  };

  // Check for high variance (indicates face/movement)
  const variances = Object.values(cornerRegions).map((p) => calculateVariance(p));
  const bestVariance = Math.max(...variances);

  return Math.min(1, bestVariance / 100); // Normalize
}

function detectHUD(frameData) {
  // Look for:
  // 1. Text/numbers (high contrast)
  // 2. Consistent positioning
  // 3. Rectangular shapes

  // Common HUD positions:
  // - Bottom: health bar, ammo, minimap
  // - Top: score, timer, objectives
  // - Sides: inventory, radar

  const zones = [];

  // Bottom HUD (very common)
  const bottomVariance = calculateRegionVariance(frameData, 0.0, 0.8, 1.0, 0.2);
  if (bottomVariance > 50) {
    zones.push(
      new SafeZone(
        "hud",
        { x: 0.0, y: 0.8, width: 1.0, height: 0.2 },
        Math.min(1, bottomVariance / 150)
      )
    );
  }

  // Top HUD (score, timer, objectives)
  const topVariance = calculateRegionVariance(frameData, 0.0, 0.0, 1.0, 0.15);
  if (topVariance > 50) {
    zones.push(
      new SafeZone(
        "hud",
        { x: 0.0, y: 0.0, width: 1.0, height: 0.15 },
        Math.min(1, topVariance / 150)
      )
    );
  }

  return zones;
}

function detectMinimap(frameData) {
  // Minimap characteristics:
  // 1. Small, usually square or rectangular
  // 2. High contrast or colored
  // 3. Corner placement (usually bottom-right)

  // Check bottom-right corner for minimap pattern
  const region = getRegionPixels(frameData, 0.8, 0.7, 0.2, 0.3);
  const variance = calculateVariance(region);
  const edgeContrast = detectEdges(region);

  return Math.min(1, (variance + edgeContrast) / 200);
}

function detectKillfeed(frameData) {
  // Killfeed characteristics:
  // 1. Vertical list of text entries
  // 2. Top-right or top area
  // 3. Rapidly changing content

  // Look for text-like patterns in top-right
  const region = getRegionPixels(frameData, 0.7, 0.0, 0.3, 0.4);
  const textLikeness = detectTextPatterns(region);

  return textLikeness;
}

// ============================================================================
// IMAGE ANALYSIS HELPERS
// ============================================================================

function getRegionPixels(frameData, x, y, w, h) {
  if (!frameData.pixels) return [];

  const startX = Math.floor(x * frameData.width);
  const startY = Math.floor(y * frameData.height);
  const endX = Math.ceil((x + w) * frameData.width);
  const endY = Math.ceil((y + h) * frameData.height);

  const pixels = [];
  const pixelData = frameData.pixels;

  for (let py = startY; py < endY; py++) {
    for (let px = startX; px < endX; px++) {
      const idx = (py * frameData.width + px) * 4; // RGBA
      pixels.push({
        r: pixelData[idx],
        g: pixelData[idx + 1],
        b: pixelData[idx + 2],
        a: pixelData[idx + 3],
      });
    }
  }

  return pixels;
}

function calculateVariance(pixels) {
  if (pixels.length === 0) return 0;

  const mean = pixels.reduce((sum, p) => sum + (p.r + p.g + p.b) / 3, 0) / pixels.length;
  const variance = pixels.reduce((sum, p) => {
    const brightness = (p.r + p.g + p.b) / 3;
    return sum + Math.pow(brightness - mean, 2);
  }, 0) / pixels.length;

  return Math.sqrt(variance);
}

function calculateRegionVariance(frameData, x, y, w, h) {
  return calculateVariance(getRegionPixels(frameData, x, y, w, h));
}

function detectEdges(pixels) {
  if (pixels.length < 4) return 0;

  let edgePixels = 0;
  for (let i = 0; i < pixels.length - 1; i++) {
    const diff =
      Math.abs(pixels[i].r - pixels[i + 1].r) +
      Math.abs(pixels[i].g - pixels[i + 1].g) +
      Math.abs(pixels[i].b - pixels[i + 1].b);
    if (diff > 50) edgePixels++;
  }

  return edgePixels / pixels.length;
}

function detectTextPatterns(pixels) {
  // Text has high contrast and specific patterns
  // High variance + edge detection = likely text
  const variance = calculateVariance(pixels);
  const edges = detectEdges(pixels);

  return Math.min(1, (variance + edges * 100) / 150);
}

module.exports = {
  detectSafeZones,
  SafeZone,
  SafeZoneMap,
};
