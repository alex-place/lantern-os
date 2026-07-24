const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const IMAGE_STORAGE_DIR = path.join(__dirname, "data/images");

// Ensure image storage directory exists
function ensureImageDir() {
  if (!fs.existsSync(IMAGE_STORAGE_DIR)) {
    fs.mkdirSync(IMAGE_STORAGE_DIR, { recursive: true });
  }
}

// Save image from base64 or buffer
function saveImage(imageBuffer, filename = null) {
  ensureImageDir();

  const ext = filename ? path.extname(filename).toLowerCase() : ".png";
  const id = crypto.randomBytes(8).toString("hex");
  const savedFilename = `${id}${ext}`;
  const filepath = path.join(IMAGE_STORAGE_DIR, savedFilename);

  fs.writeFileSync(filepath, imageBuffer);

  return {
    id,
    filename: savedFilename,
    path: filepath,
    url: `/images/${savedFilename}`,
    timestamp: new Date().toISOString(),
  };
}

// Load image metadata
function getImageMetadata(imageId) {
  ensureImageDir();

  const files = fs.readdirSync(IMAGE_STORAGE_DIR);
  const matching = files.find((f) => f.startsWith(imageId));

  if (!matching) return null;

  const filepath = path.join(IMAGE_STORAGE_DIR, matching);
  const stat = fs.statSync(filepath);

  return {
    id: imageId,
    filename: matching,
    path: filepath,
    url: `/images/${matching}`,
    size: stat.size,
    timestamp: stat.mtime.toISOString(),
  };
}

// List all images
function listImages() {
  ensureImageDir();

  return fs.readdirSync(IMAGE_STORAGE_DIR).map((filename) => {
    const filepath = path.join(IMAGE_STORAGE_DIR, filename);
    const stat = fs.statSync(filepath);
    const [id] = filename.split(".");

    return {
      id,
      filename,
      url: `/images/${filename}`,
      size: stat.size,
      timestamp: stat.mtime.toISOString(),
    };
  });
}

// Delete image
function deleteImage(imageId) {
  ensureImageDir();

  const files = fs.readdirSync(IMAGE_STORAGE_DIR);
  const matching = files.find((f) => f.startsWith(imageId));

  if (!matching) return false;

  const filepath = path.join(IMAGE_STORAGE_DIR, matching);
  fs.unlinkSync(filepath);

  return true;
}

// Attach image to response metadata
function attachImageToResponse(response, imageIds = []) {
  if (!Array.isArray(imageIds) || imageIds.length === 0) {
    return response;
  }

  return {
    ...response,
    images: imageIds
      .map((id) => getImageMetadata(id))
      .filter((img) => img !== null),
  };
}

module.exports = {
  saveImage,
  getImageMetadata,
  listImages,
  deleteImage,
  attachImageToResponse,
  IMAGE_STORAGE_DIR,
};
