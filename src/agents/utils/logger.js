import fs from "fs";
import path from "path";
import os from "os";

/**
 * Simple file-based logger for agent controller and wrapper operations
 * Logs to /data/openclaw-wrapper/logs in production, ~/.openclaw-wrapper/logs locally
 */

// Determine log directory - use /data in production, fallback to home dir locally
let LOG_DIR = "/data/openclaw-wrapper/logs";
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.chmodSync(LOG_DIR, 0o755);
} catch (err) {
  // Fallback to home directory for local development
  LOG_DIR = path.join(os.homedir(), ".openclaw-wrapper/logs");
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err2) {
    console.warn(
      `[logger] Could not create log directory (${LOG_DIR}), logs will only print to console`,
    );
    LOG_DIR = null;
  }
}

const LOG_FILE = LOG_DIR ? path.join(LOG_DIR, "agent-api.log") : null;
const COMMAND_LOG_FILE = LOG_DIR ? path.join(LOG_DIR, "commands.log") : null;

function getTimestamp() {
  return new Date().toISOString();
}

function formatLogEntry(level, message, data = null) {
  const timestamp = getTimestamp();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : "";
  return `[${timestamp}] [${level}] ${message}${dataStr}\n`;
}

function writeLog(entry, logFile) {
  if (!logFile) return; // Skip if logging disabled
  try {
    fs.appendFileSync(logFile, entry, { encoding: "utf8" });
  } catch (err) {
    console.error(`Failed to write to log file (${logFile}):`, err);
  }
}

export const logger = {
  info: (message, data) => {
    const entry = formatLogEntry("INFO", message, data);
    console.log(`[AGENT-API] ${message}`, data || "");
    writeLog(entry, LOG_FILE);
  },

  error: (message, error, data) => {
    const errorStr = error instanceof Error ? error.message : String(error);
    const entry = formatLogEntry("ERROR", message, {
      error: errorStr,
      ...data,
    });
    console.error(`[AGENT-API] ERROR: ${message}`, error);
    writeLog(entry, LOG_FILE);
  },

  debug: (message, data) => {
    const entry = formatLogEntry("DEBUG", message, data);
    console.debug(`[AGENT-API] ${message}`, data || "");
    writeLog(entry, LOG_FILE);
  },

  warn: (message, data) => {
    const entry = formatLogEntry("WARN", message, data);
    console.warn(`[AGENT-API] WARNING: ${message}`, data || "");
    writeLog(entry, LOG_FILE);
  },

  // Command execution logging
  command: (command, data) => {
    const entry = formatLogEntry("COMMAND", command, data);
    console.log(`[CMD] ${command}`, data || "");
    writeLog(entry, COMMAND_LOG_FILE);
  },

  commandResult: (command, result) => {
    const entry = formatLogEntry("COMMAND_RESULT", command, result);
    console.log(`[CMD_RESULT] ${command}`, result || "");
    writeLog(entry, COMMAND_LOG_FILE);
  },

  getLogPath: () => LOG_FILE,
  getCommandLogPath: () => COMMAND_LOG_FILE,
  getLogDir: () => LOG_DIR,
};

export default logger;
