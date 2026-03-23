import express from "express";
import * as fileController from "../controllers/fileController.js";

const router = express.Router();

/**
 * GET /api/files - List all task files
 */
router.get("/", fileController.listFiles);

/**
 * POST /api/files - Upload/create a file
 * Body: { name: string, content: string }
 */
router.post("/", fileController.uploadFile);

/**
 * GET /api/files/:filename - Get file content
 */
router.get("/:filename", fileController.getFile);

/**
 * PUT /api/files/:filename - Replace file content
 * Body: { content: string }
 */
router.put("/:filename", fileController.updateFile);

/**
 * DELETE /api/files/:filename - Delete a file
 */
router.delete("/:filename", fileController.deleteFile);

export default router;
