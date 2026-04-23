import fs from "fs";
import path from "path";
import configManager from "../utils/configManager.js";
import logger from "../utils/logger.js";

function getSkillsDir(agentId) {
  const agentConfig = configManager.getAgentConfig(agentId);
  if (!agentConfig) return null;
  const workspace = agentConfig.workspace || `/data/.openclaw/workspace-${agentId}`;
  return path.join(workspace, "skills");
}

const VALID_NAME = /^[a-z0-9_-]+$/;

function validateName(name) {
  return typeof name === "string" && VALID_NAME.test(name);
}

function buildSkillMd(name, description, content) {
  const safeDescription = description.replace(/[\r\n]+/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${safeDescription}\n---\n\n${content}`;
}

function parseSkillMd(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return { description: "", content: raw };
  const frontmatter = match[1];
  const content = match[2];
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return {
    description: descMatch ? descMatch[1].trim() : "",
    content,
  };
}

/**
 * GET /api/directives/:agentId
 * List all directives for the agent (name + description).
 */
export async function list(req, res) {
  const { agentId } = req.params;
  const skillsDir = getSkillsDir(agentId);

  if (!skillsDir) {
    return res.status(404).json({ error: `Agent ${agentId} not found` });
  }

  if (!fs.existsSync(skillsDir)) {
    return res.json({ directives: [] });
  }

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const directives = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const raw = fs.readFileSync(skillPath, "utf8");
      const { description } = parseSkillMd(raw);
      directives.push({ name: entry.name, description });
    }

    return res.json({ directives });
  } catch (err) {
    logger.error("directivesController.list: failed", { agentId, error: err.message });
    return res.status(500).json({ error: "Failed to list directives" });
  }
}

/**
 * POST /api/directives/:agentId
 * Create a directive. Body: { name, description, content }
 */
export async function create(req, res, restartGateway) {
  const { agentId } = req.params;
  const { name, description, content } = req.body;

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  if (!validateName(name)) {
    return res.status(400).json({ error: "name must be snake_case (a-z, 0-9, _, -)" });
  }
  if (!description || typeof description !== "string") {
    return res.status(400).json({ error: "description is required" });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content is required" });
  }

  const skillsDir = getSkillsDir(agentId);
  if (!skillsDir) {
    return res.status(404).json({ error: `Agent ${agentId} not found` });
  }

  const skillDir = path.join(skillsDir, name);
  const skillPath = path.join(skillDir, "SKILL.md");

  if (fs.existsSync(skillPath)) {
    return res.status(409).json({ error: `Directive '${name}' already exists. Use PUT to update.` });
  }

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, buildSkillMd(name, description, content), "utf8");
    logger.info("directivesController.create: directive created", { agentId, name });
  } catch (err) {
    logger.error("directivesController.create: failed to write", { agentId, name, error: err.message });
    return res.status(500).json({ error: "Failed to create directive" });
  }

  res.json({ ok: true, name });

  try {
    await restartGateway();
    logger.info("directivesController.create: gateway restarted", { agentId, name });
  } catch (err) {
    logger.error("directivesController.create: gateway restart failed", { error: err.message });
  }
}

/**
 * GET /api/directives/:agentId/:name
 * Get a directive's content.
 */
export async function get(req, res) {
  const { agentId, name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({ error: "name must be snake_case (a-z, 0-9, _, -)" });
  }

  const skillsDir = getSkillsDir(agentId);
  if (!skillsDir) {
    return res.status(404).json({ error: `Agent ${agentId} not found` });
  }

  const skillPath = path.join(skillsDir, name, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    return res.status(404).json({ error: `Directive '${name}' not found` });
  }

  try {
    const raw = fs.readFileSync(skillPath, "utf8");
    const { description, content } = parseSkillMd(raw);
    return res.json({ name, description, content });
  } catch (err) {
    logger.error("directivesController.get: failed", { agentId, name, error: err.message });
    return res.status(500).json({ error: "Failed to read directive" });
  }
}

/**
 * PUT /api/directives/:agentId/:name
 * Replace a directive's content. Body: { description, content }
 */
export async function update(req, res, restartGateway) {
  const { agentId, name } = req.params;
  const { description, content } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ error: "name must be snake_case (a-z, 0-9, _, -)" });
  }

  if (!description || typeof description !== "string") {
    return res.status(400).json({ error: "description is required" });
  }
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content is required" });
  }

  const skillsDir = getSkillsDir(agentId);
  if (!skillsDir) {
    return res.status(404).json({ error: `Agent ${agentId} not found` });
  }

  const skillDir = path.join(skillsDir, name);
  const skillPath = path.join(skillDir, "SKILL.md");

  if (!fs.existsSync(skillPath)) {
    return res.status(404).json({ error: `Directive '${name}' not found` });
  }

  try {
    fs.writeFileSync(skillPath, buildSkillMd(name, description, content), "utf8");
    logger.info("directivesController.update: directive updated", { agentId, name });
  } catch (err) {
    logger.error("directivesController.update: failed to write", { agentId, name, error: err.message });
    return res.status(500).json({ error: "Failed to update directive" });
  }

  res.json({ ok: true, name });

  try {
    await restartGateway();
    logger.info("directivesController.update: gateway restarted", { agentId, name });
  } catch (err) {
    logger.error("directivesController.update: gateway restart failed", { error: err.message });
  }
}

/**
 * DELETE /api/directives/:agentId/:name
 * Delete a directive.
 */
export async function remove(req, res, restartGateway) {
  const { agentId, name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({ error: "name must be snake_case (a-z, 0-9, _, -)" });
  }

  const skillsDir = getSkillsDir(agentId);
  if (!skillsDir) {
    return res.status(404).json({ error: `Agent ${agentId} not found` });
  }

  const skillDir = path.join(skillsDir, name);
  if (!fs.existsSync(skillDir)) {
    return res.status(404).json({ error: `Directive '${name}' not found` });
  }

  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
    logger.info("directivesController.remove: directive deleted", { agentId, name });
  } catch (err) {
    logger.error("directivesController.remove: failed to delete", { agentId, name, error: err.message });
    return res.status(500).json({ error: "Failed to delete directive" });
  }

  res.json({ ok: true, name });

  try {
    await restartGateway();
    logger.info("directivesController.remove: gateway restarted", { agentId, name });
  } catch (err) {
    logger.error("directivesController.remove: gateway restart failed", { error: err.message });
  }
}
