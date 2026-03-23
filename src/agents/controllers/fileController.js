/**
 * File Controller
 * Manages shared task files accessible by all agents.
 * Files live at $TASK_FILES_DIR (default: /data/task-files) on the persistent volume.
 * Kept outside agent workspaces to avoid conflicts with openclaw's workspace management.
 */
import fs from "fs";
import path from "path";
import logger from "../utils/logger.js";

const TASK_FILES_DIR = process.env.TASK_FILES_DIR?.trim() || "/data/task-files";

// Only allow safe filenames: alphanumeric, dashes, underscores, dots. No path traversal.
const SAFE_FILENAME = /^[a-zA-Z0-9_\-. ]+$/;

function ensureDir() {
  if (!fs.existsSync(TASK_FILES_DIR)) {
    fs.mkdirSync(TASK_FILES_DIR, { recursive: true });
  }
}

function resolveSafe(filename) {
  const resolved = path.resolve(TASK_FILES_DIR, filename);
  if (!resolved.startsWith(path.resolve(TASK_FILES_DIR) + path.sep)) {
    throw { statusCode: 400, message: "Invalid filename" };
  }
  return resolved;
}

/**
 * GET /api/files
 * List all task files with metadata.
 */
export async function listFiles(_req, res) {
  try {
    ensureDir();
    const entries = fs.readdirSync(TASK_FILES_DIR, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => {
        const filePath = path.join(TASK_FILES_DIR, e.name);
        const stat = fs.statSync(filePath);
        return {
          name: e.name,
          size: stat.size,
          updatedAt: stat.mtime,
          path: filePath,
        };
      });
    logger.info("listFiles", { count: files.length });
    return res.json({ files, dir: TASK_FILES_DIR });
  } catch (error) {
    logger.error("listFiles failed", error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}

function writeOneFile(name, content) {
  if (!name || typeof name !== "string") throw { statusCode: 400, message: "name is required" };
  if (!SAFE_FILENAME.test(name)) throw { statusCode: 400, message: "Invalid filename — use alphanumeric, dashes, underscores, and dots only" };
  if (content === undefined || content === null) throw { statusCode: 400, message: "content is required" };
  const filePath = resolveSafe(name);
  fs.writeFileSync(filePath, content, "utf8");
  const stat = fs.statSync(filePath);
  return { name, size: stat.size, path: filePath, updatedAt: stat.mtime };
}

/**
 * POST /api/files
 * Upload or create one or more files.
 * Single:  { name: string, content: string }
 * Batch:   { files: [{ name, content }, ...] }
 */
export async function uploadFile(req, res) {
  try {
    ensureDir();
    const { files, name, content } = req.body;

    // Batch mode
    if (Array.isArray(files)) {
      const results = [];
      const errors = [];
      for (const f of files) {
        try {
          results.push(writeOneFile(f.name, f.content));
        } catch (err) {
          errors.push({ name: f.name, error: err.message });
        }
      }
      logger.info("uploadFile batch", { written: results.length, failed: errors.length });
      return res.status(errors.length === files.length ? 400 : 201).json({
        success: errors.length === 0,
        files: results,
        errors: errors.length ? errors : undefined,
      });
    }

    // Single mode
    const result = writeOneFile(name, content);
    logger.info("uploadFile", { name, size: result.size });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    logger.error("uploadFile failed", error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}

/**
 * GET /api/files/:filename
 * Get file content.
 */
export async function getFile(req, res) {
  try {
    ensureDir();
    const { filename } = req.params;
    const filePath = resolveSafe(filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const content = fs.readFileSync(filePath, "utf8");
    const stat = fs.statSync(filePath);
    logger.info("getFile", { filename });
    return res.json({ name: filename, content, size: stat.size, updatedAt: stat.mtime, path: filePath });
  } catch (error) {
    logger.error("getFile failed", error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}

/**
 * PUT /api/files/:filename
 * Replace file content.
 * Body: { content: string }
 */
export async function updateFile(req, res) {
  try {
    ensureDir();
    const { filename } = req.params;
    const { content } = req.body;
    const filePath = resolveSafe(filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found — use POST /api/files to create it" });
    }
    if (content === undefined || content === null) {
      return res.status(400).json({ error: "content is required" });
    }
    fs.writeFileSync(filePath, content, "utf8");
    const stat = fs.statSync(filePath);
    logger.info("updateFile", { filename, size: stat.size });
    return res.json({ success: true, name: filename, size: stat.size, updatedAt: stat.mtime });
  } catch (error) {
    logger.error("updateFile failed", error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}

/**
 * DELETE /api/files/:filename
 * Delete a file.
 */
export async function deleteFile(req, res) {
  try {
    ensureDir();
    const { filename } = req.params;
    const filePath = resolveSafe(filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    fs.unlinkSync(filePath);
    logger.info("deleteFile", { filename });
    return res.json({ success: true, name: filename });
  } catch (error) {
    logger.error("deleteFile failed", error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}
