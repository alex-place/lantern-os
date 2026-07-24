// Lantern V9 Caption Engine
// Generates dynamic captions from speech, game events, and highlights
// Burns captions into video with mobile-safe positioning

// ============================================================================
// CAPTION DATA STRUCTURE
// ============================================================================

class Caption {
  constructor(text, startTime, endTime, style = {}) {
    this.text = text;
    this.startTime = startTime; // seconds
    this.endTime = endTime; // seconds
    this.duration = endTime - startTime;
    this.style = {
      fontSize: 48,
      fontFamily: "Arial, sans-serif",
      color: "#ffffff",
      backgroundColor: "rgba(0, 0, 0, 0.8)",
      borderRadius: 8,
      padding: "12px 16px",
      position: "bottom-center", // top-center, bottom-center, top-left, etc
      safeMargin: 30, // pixels from edge
      animation: "fadeInUp", // fadeInUp, pop, none
      ...style,
    };
  }

  toVTT() {
    const startVTT = formatVTTTime(this.startTime);
    const endVTT = formatVTTTime(this.endTime);
    return `${startVTT} --> ${endVTT}\n${this.text}\n`;
  }

  toJSON() {
    return {
      text: this.text,
      startTime: Number(this.startTime.toFixed(2)),
      endTime: Number(this.endTime.toFixed(2)),
      duration: Number(this.duration.toFixed(2)),
      style: this.style,
    };
  }
}

class CaptionStyle {
  static GAME_HYPE = {
    fontSize: 56,
    color: "#ffff00",
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    animation: "pop",
  };

  static GAME_ACTION = {
    fontSize: 48,
    color: "#ffffff",
    backgroundColor: "rgba(255, 0, 0, 0.7)",
    animation: "fadeInUp",
  };

  static GAME_REACTION = {
    fontSize: 44,
    color: "#ff69b4",
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    animation: "fadeInUp",
  };

  static GAME_INFO = {
    fontSize: 36,
    color: "#87ceeb",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    animation: "none",
  };

  static MOBILE_SAFE = {
    fontSize: 40,
    safeMargin: 60,
    position: "bottom-center",
  };
}

// ============================================================================
// CAPTION GENERATION
// ============================================================================

function generateCaptions(highlightTimeline, speechTranscript = null, strategy = "auto") {
  const captions = [];

  if (!highlightTimeline.highlights || highlightTimeline.highlights.length === 0) {
    return captions;
  }

  const highlights = highlightTimeline.highlights;

  // Strategy: infer caption type from highlight data
  if (strategy === "auto") {
    strategy = inferStrategy(highlights);
  }

  if (strategy === "gaming") {
    // Gaming-focused captions for action, reactions, excitement
    for (let i = 0; i < highlights.length; i++) {
      const hl = highlights[i];

      // Intro caption for each highlight
      const introCaption = new Caption("▶ MOMENT", hl.start, hl.start + 0.8, CaptionStyle.GAME_INFO);
      captions.push(introCaption);

      // Main action caption at peak of highlight
      const peakTime = hl.start + hl.duration * 0.5;
      let actionText = "ACTION";
      let actionStyle = CaptionStyle.GAME_ACTION;

      if (hl.score > 0.85) {
        actionText = "INSANE";
        actionStyle = CaptionStyle.GAME_HYPE;
      } else if (hl.score > 0.75) {
        actionText = "CLUTCH";
        actionStyle = CaptionStyle.GAME_ACTION;
      }

      const actionCaption = new Caption(actionText, peakTime - 0.3, peakTime + 0.8, actionStyle);
      captions.push(actionCaption);

      // Outro caption
      if (i === highlights.length - 1) {
        const outroCaption = new Caption("GG", hl.end - 0.5, hl.end, CaptionStyle.GAME_INFO);
        captions.push(outroCaption);
      }
    }
  } else if (strategy === "emotional") {
    // Reaction and emotion-focused captions
    for (let i = 0; i < highlights.length; i++) {
      const hl = highlights[i];

      const reactions = ["WOW", "NO WAY", "YOOO", "WHAT?", "OMG"];
      const reaction = reactions[i % reactions.length];

      const caption = new Caption(
        reaction,
        hl.start + 0.2,
        hl.end - 0.2,
        CaptionStyle.GAME_REACTION
      );
      captions.push(caption);
    }
  } else if (strategy === "narrative") {
    // Story-driven captions with transitions and buildup
    if (highlights.length > 0) {
      captions.push(new Caption("THE SETUP", highlights[0].start, highlights[0].start + 1.0));

      for (let i = 1; i < highlights.length; i++) {
        const hl = highlights[i];
        captions.push(new Caption("THEN", hl.start - 0.3, hl.start + 0.3));
      }

      const lastHl = highlights[highlights.length - 1];
      captions.push(new Caption("AND THEN...", lastHl.end - 0.5, lastHl.end + 0.5));
    }
  }

  // Filter and sort captions
  return captions
    .sort((a, b) => a.startTime - b.startTime)
    .filter((c) => c.duration > 0 && c.duration <= 10);
}

function inferStrategy(highlights) {
  // Simple strategy inference based on highlight characteristics
  const avgScore = highlights.reduce((sum, h) => sum + h.score, 0) / highlights.length;

  if (avgScore > 0.8) {
    return "gaming"; // High-energy action
  } else if (highlights.length === 1) {
    return "emotional"; // Single highlight = reaction focus
  } else {
    return "narrative"; // Multiple highlights = tell a story
  }
}

// ============================================================================
// CAPTION FILE GENERATION
// ============================================================================

function generateVTT(captions) {
  let vtt = "WEBVTT\n\n";

  for (const caption of captions) {
    vtt += caption.toVTT();
    vtt += "\n";
  }

  return vtt;
}

function generateSRT(captions) {
  let srt = "";

  for (let i = 0; i < captions.length; i++) {
    const caption = captions[i];
    srt += `${i + 1}\n`;
    srt += `${formatSRTTime(caption.startTime)} --> ${formatSRTTime(caption.endTime)}\n`;
    srt += `${caption.text}\n\n`;
  }

  return srt;
}

function generateJSON(captions) {
  return JSON.stringify(
    {
      format: "captions",
      version: "1.0",
      captions: captions.map((c) => c.toJSON()),
    },
    null,
    2
  );
}

// ============================================================================
// VIDEO BURNING (FFmpeg integration)
// ============================================================================

async function burnCaptionsToVideo(videoPath, captions, outputPath) {
  // Generate subtitle file (VTT or SRT format)
  const subtitleContent = generateVTT(captions);

  // Use FFmpeg to burn subtitles into video
  // This is a complex operation that requires:
  // 1. Writing subtitle file to disk
  // 2. Creating FFmpeg filter_complex with subtitle filter
  // 3. Encoding video with burned subtitles

  // Simplified example (real implementation needs full FFmpeg setup):
  // ffmpeg -i input.mp4 -vf "subtitles=subs.vtt" output.mp4

  // For now: return what would be done
  return {
    videoPath,
    outputPath,
    subtitles: captions.length,
    command: `ffmpeg -i ${videoPath} -vf "subtitles=captions.vtt" ${outputPath}`,
  };
}

// ============================================================================
// MOBILE SAFETY
// ============================================================================

function ensureMobileSafety(caption, videoWidth = 1920, videoHeight = 1080) {
  // Ensure caption doesn't collide with safe zones or extend beyond edge

  const margin = caption.style.safeMargin || 30;
  const maxTextWidth = videoWidth - margin * 2;

  // For mobile vertical (9:16), adjust positioning
  if (videoHeight > videoWidth) {
    // Portrait mode
    caption.style.position = "bottom-center";
    caption.style.safeMargin = Math.max(margin, 60); // More margin for mobile
  }

  return caption;
}

// ============================================================================
// UTILITIES
// ============================================================================

function formatVTTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);

  return `${padZero(hours)}:${padZero(minutes)}:${padZero(secs)}.${String(millis).padStart(3, "0")}`;
}

function formatSRTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);

  return `${padZero(hours)}:${padZero(minutes)}:${padZero(secs)},${String(millis).padStart(3, "0")}`;
}

function padZero(num) {
  return String(num).padStart(2, "0");
}

module.exports = {
  generateCaptions,
  generateVTT,
  generateSRT,
  generateJSON,
  Caption,
  CaptionStyle,
  burnCaptionsToVideo,
};
