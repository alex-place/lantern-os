// Lantern V9 Retention Engine
// Generates A/B/C variants of highlight clips with different hooks, pacing, and captions
// Optimized for viral retention, completion rate, and rewatch potential

// ============================================================================
// HOOK LIBRARY
// ============================================================================

const hookLibrary = {
  // Action-focused hooks
  action: [
    { text: "WAIT FOR IT", duration: 0.8 },
    { text: "ARE YOU READY", duration: 1.0 },
    { text: "WATCH THIS", duration: 0.7 },
    { text: "NOT PREPARED", duration: 0.9 },
    { text: "INSANE MOMENT", duration: 0.8 },
  ],

  // Reaction-focused hooks
  reaction: [
    { text: "MY REACTION", duration: 0.6 },
    { text: "YOOO", duration: 0.5 },
    { text: "NO WAY", duration: 0.5 },
    { text: "WHAT JUST HAPPENED", duration: 1.0 },
    { text: "BRUH", duration: 0.4 },
  ],

  // Suspense hooks
  suspense: [
    { text: "THIS DIDN'T GO WELL", duration: 1.0 },
    { text: "SOMETHING'S WRONG", duration: 1.0 },
    { text: "OH NO", duration: 0.6 },
    { text: "THIS IS GETTING CRAZY", duration: 1.0 },
    { text: "NOBODY SAW THIS COMING", duration: 1.0 },
  ],

  // Climax hooks
  climax: [
    { text: "PEAK MOMENT", duration: 0.7 },
    { text: "LEGENDARY", duration: 0.7 },
    { text: "IMPOSSIBLE", duration: 0.8 },
    { text: "TOO CLEAN", duration: 0.6 },
    { text: "THAT'S INSANE", duration: 0.7 },
  ],

  // Contrast hooks
  contrast: [
    { text: "VS", duration: 0.4 },
    { text: "VS WHAT I EXPECTED", duration: 1.0 },
    { text: "THE DIFFERENCE", duration: 0.8 },
    { text: "PLOT TWIST", duration: 0.7 },
    { text: "NEVER EXPECTED THIS", duration: 1.0 },
  ],
};

// ============================================================================
// CAPTION LIBRARY
// ============================================================================

const captionLibrary = {
  // Excitement captions
  excitement: ["INSANE", "WHAT A MOMENT", "YOOO", "NO WAY", "LET'S GO", "PEAK ENERGY"],

  // Action captions
  action: ["CLUTCH PLAY", "CLEAN", "SKILLED", "TIMING", "CALCULATED", "BIG BRAIN PLAY"],

  // Reaction captions
  reaction: ["DIDN'T EXPECT", "SHOCKED", "CONFUSED", "AMAZED", "MIND BLOWN", "WOW"],

  // Suspense captions
  suspense: ["DANGEROUS", "RISKY", "COULD GO WRONG", "BOLD MOVE", "HIGH STAKES", "TENSION"],

  // Victory captions
  victory: ["WON", "DOMINATED", "UNSTOPPABLE", "CHAMPION", "VICTORY", "PERFECT ROUND"],

  // Failure captions
  failure: ["FAILED", "EPIC FAIL", "OOPS", "MISTAKE", "CRASHED", "DIDN'T LAND"],

  // Transition captions
  transition: ["THEN", "NEXT", "WAIT", "BUT THEN", "AND THEN", "SUDDENLY"],

  // Ending captions
  ending: ["WORTH IT", "BEST MOMENT", "NEVER FORGET", "ICONIC", "GG", "THAT'S ALL FOLKS"],
};

// ============================================================================
// PACING PROFILES
// ============================================================================

const pacingProfiles = {
  // Fast cuts, high energy
  fast: {
    name: "Fast Cut",
    cutFrequency: 0.5, // Cut every 0.5 seconds
    transitionDuration: 0.1,
    captionHoldTime: 0.6,
    musicIntensity: 0.8,
    description: "Quick cuts, rapid captions, high energy music",
  },

  // Medium pacing, balanced
  balanced: {
    name: "Balanced",
    cutFrequency: 1.0,
    transitionDuration: 0.15,
    captionHoldTime: 1.0,
    musicIntensity: 0.5,
    description: "Natural pacing, readable captions, balanced music",
  },

  // Slow, dramatic
  dramatic: {
    name: "Dramatic",
    cutFrequency: 2.0,
    transitionDuration: 0.3,
    captionHoldTime: 1.5,
    musicIntensity: 0.3,
    description: "Longer shots, dramatic pauses, cinematic feel",
  },

  // Meme-style rapid cuts
  meme: {
    name: "Meme Chaos",
    cutFrequency: 0.3,
    transitionDuration: 0.05,
    captionHoldTime: 0.4,
    musicIntensity: 0.9,
    description: "Rapid-fire cuts, tiny captions, chaotic energy",
  },

  // Slow build tension
  buildup: {
    name: "Build Up",
    cutFrequency: 1.5, // Slow start
    transitionDuration: 0.2,
    captionHoldTime: 1.2,
    musicIntensity: 0.2, // Starts quiet
    description: "Slow intro building to climax, tension music",
  },
};

// ============================================================================
// RETENTION VARIANT CLASS
// ============================================================================

class RetentionVariant {
  constructor(variantId, highlightTimeline, hook, pacing, endingCaption) {
    this.variantId = variantId;
    this.highlightTimeline = highlightTimeline;
    this.hook = hook;
    this.pacing = pacing;
    this.endingCaption = endingCaption;
    this.captions = [];
    this.estimatedCompletionRate = 0;
    this.estimatedReWatchRate = 0;
    this.estimatedViralScore = 0;
  }

  addCaption(time, text, duration = 1.0) {
    this.captions.push({ time, text, duration });
  }

  calculateMetrics() {
    // Estimate completion rate based on hook strength and pacing
    const hookStrength = this.hook.text.length > 6 ? 0.8 : 0.6; // Longer hooks = better
    const pacingScore = this.pacing.cutFrequency > 0.5 ? 0.9 : 0.7; // Faster = higher engagement
    this.estimatedCompletionRate = Math.min(1, 0.5 + hookStrength * 0.25 + pacingScore * 0.25);

    // Estimate rewatch rate based on surprise and pacing variation
    const variationScore = this.captions.length > 5 ? 0.8 : 0.5;
    this.estimatedReWatchRate = Math.min(1, 0.3 + variationScore * 0.3 + hookStrength * 0.2);

    // Viral score combines all factors
    this.estimatedViralScore = Math.min(
      1,
      hookStrength * 0.4 + pacingScore * 0.3 + variationScore * 0.3
    );
  }

  toJSON() {
    return {
      variantId: this.variantId,
      hook: this.hook,
      pacing: this.pacing.name,
      endingCaption: this.endingCaption,
      captionCount: this.captions.length,
      captions: this.captions,
      estimatedCompletionRate: Number(this.estimatedCompletionRate.toFixed(2)),
      estimatedReWatchRate: Number(this.estimatedReWatchRate.toFixed(2)),
      estimatedViralScore: Number(this.estimatedViralScore.toFixed(2)),
    };
  }
}

// ============================================================================
// MAIN GENERATION FUNCTION
// ============================================================================

function generateVariants(highlightTimeline, videoMetadata = {}) {
  const variants = [];

  // Variant A: Hook-focused, fast pacing, high energy
  const variantA = new RetentionVariant(
    "variant-a-hook-focused",
    highlightTimeline,
    hookLibrary.action[0],
    pacingProfiles.fast,
    captionLibrary.ending[0]
  );
  generateCaptions(variantA, "action-focused");
  variantA.calculateMetrics();
  variants.push(variantA);

  // Variant B: Reaction-focused, balanced pacing, emotional
  const variantB = new RetentionVariant(
    "variant-b-reaction-focused",
    highlightTimeline,
    hookLibrary.reaction[0],
    pacingProfiles.balanced,
    captionLibrary.ending[4]
  );
  generateCaptions(variantB, "reaction-focused");
  variantB.calculateMetrics();
  variants.push(variantB);

  // Variant C: Suspense-focused, dramatic pacing, buildup
  const variantC = new RetentionVariant(
    "variant-c-suspense-drama",
    highlightTimeline,
    hookLibrary.suspense[0],
    pacingProfiles.buildup,
    captionLibrary.ending[3]
  );
  generateCaptions(variantC, "suspense-focused");
  variantC.calculateMetrics();
  variants.push(variantC);

  return variants;
}

// ============================================================================
// CAPTION GENERATION STRATEGY
// ============================================================================

function generateCaptions(variant, strategy) {
  const timeline = variant.highlightTimeline;

  if (!timeline.highlights || timeline.highlights.length === 0) {
    return;
  }

  const highlights = timeline.highlights;

  if (strategy === "action-focused") {
    // Dense captions highlighting every action moment
    highlights.forEach((hl, idx) => {
      variant.addCaption(hl.start + 0.2, captionLibrary.action[idx % captionLibrary.action.length], 0.8);
      if (hl.score > 0.8) {
        variant.addCaption(hl.end - 0.5, captionLibrary.excitement[idx % captionLibrary.excitement.length], 0.7);
      }
    });
  } else if (strategy === "reaction-focused") {
    // Emotional journey captions
    highlights.forEach((hl, idx) => {
      if (idx === 0) {
        variant.addCaption(hl.start, captionLibrary.reaction[0], 1.0);
      }
      variant.addCaption(hl.start + hl.duration * 0.5, captionLibrary.reaction[(idx + 1) % captionLibrary.reaction.length], 0.9);
    });
  } else if (strategy === "suspense-focused") {
    // Build tension with few captions
    if (highlights.length > 0) {
      const firstHl = highlights[0];
      const lastHl = highlights[highlights.length - 1];

      variant.addCaption(firstHl.start + 0.5, captionLibrary.suspense[0], 1.0);
      if (highlights.length > 1) {
        variant.addCaption(highlights[Math.floor(highlights.length / 2)].start, captionLibrary.transition[0], 0.8);
      }
      variant.addCaption(lastHl.end - 0.7, captionLibrary.excitement[0], 1.0);
    }
  }
}

// ============================================================================
// METRICS & SCORING
// ============================================================================

function scoreCompletionPotential(variant) {
  // Higher if hook appears early
  const hookScore = variant.hook.duration > 0.7 ? 0.9 : 0.7;

  // Higher if pacing is fast
  const pacingScore = variant.pacing.cutFrequency < 1.0 ? 0.9 : 0.6;

  // Higher if good caption coverage
  const captionScore = variant.captions.length > 5 ? 0.8 : 0.5;

  return (hookScore + pacingScore + captionScore) / 3;
}

function scoreVirality(variant) {
  // Novelty: Unique hook choice
  const noveltyScore = 0.6 + Math.random() * 0.4;

  // Hook strength
  const hookScore = variant.hook.text.length > 8 ? 0.8 : 0.6;

  // Energy level (pacing cutFrequency)
  const energyScore = 1.0 - variant.pacing.cutFrequency / 5.0;

  return (noveltyScore + hookScore + energyScore) / 3;
}

module.exports = {
  generateVariants,
  RetentionVariant,
  hookLibrary,
  captionLibrary,
  pacingProfiles,
};
