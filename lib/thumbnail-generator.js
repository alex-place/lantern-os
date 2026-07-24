// Video Thumbnail Generator
// Extracts first frame from video files using FFmpeg

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * Generate a thumbnail from a video file
 * @param {string} videoPath - Path to the video file
 * @param {string} outputPath - Path where thumbnail should be saved
 * @returns {Promise<string>} Path to generated thumbnail on success
 */
function generateThumbnail(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Check if input video exists
    if (!fs.existsSync(videoPath)) {
      reject(new Error(`Video file not found: ${videoPath}`));
      return;
    }

    console.log(`[thumbnail] Generating thumbnail from ${videoPath}`);

    // Use ffmpeg to extract first frame
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      videoPath,
      "-vframes", // Extract only 1 frame
      "1",
      "-q:v", // Quality (lower = better, 2 = high quality)
      "2",
      "-f", // Force format
      "image2", // Image format
      outputPath
    ], {
      stdio: ["ignore", "ignore", "pipe"] // Ignore stdin/stdout, capture stderr
    });

    let errorOutput = "";
    let closed = false;

    ffmpeg.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (closed) return; // Already handled
      closed = true;

      if (code === 0) {
        if (fs.existsSync(outputPath)) {
          console.log(`[thumbnail] ✅ Generated: ${outputPath}`);
          resolve(outputPath);
        } else {
          reject(new Error("Thumbnail file was not created"));
        }
      } else {
        console.error(`[thumbnail] ❌ FFmpeg failed with code ${code}`);
        if (errorOutput) {
          console.error(`[thumbnail] Error output: ${errorOutput.substring(0, 200)}`);
        }
        reject(new Error(`FFmpeg failed with code ${code}`));
      }
    });

    ffmpeg.on("error", (err) => {
      if (!closed) {
        closed = true;
        console.error(`[thumbnail] ❌ Spawn error: ${err.message}`);
        reject(err);
      }
    });

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      if (!closed) {
        closed = true;
        ffmpeg.kill();
        reject(new Error("FFmpeg thumbnail generation timeout"));
      }
    }, 30000);

    ffmpeg.on("exit", () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Generate thumbnail for a project entry
 * @param {string} repoRoot - Repository root path
 * @param {string} entryId - Entry ID
 * @param {string} videoPath - Path to video (relative to repoRoot)
 * @returns {Promise<string|null>} Path to thumbnail or null if failed
 */
async function generateProjectThumbnail(repoRoot, entryId, videoPath) {
  try {
    const fullVideoPath = path.join(repoRoot, videoPath);
    const entryDir = path.join(repoRoot, "data", "creator", "entries", entryId);
    const thumbnailPath = path.join(entryDir, "thumbnail.jpg");
    const relativeThumbnailPath = path.relative(repoRoot, thumbnailPath);

    await generateThumbnail(fullVideoPath, thumbnailPath);
    return relativeThumbnailPath;
  } catch (error) {
    console.error(`[thumbnail] Failed to generate project thumbnail: ${error.message}`);
    return null;
  }
}

module.exports = {
  generateThumbnail,
  generateProjectThumbnail,
};
