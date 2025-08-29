// logger.js
import { promises as fs } from "fs";
import path from "path";
import getSwissTime from "./timeHelper.js";
import { notifyHS } from "./notifyHS.js";

const LOG_DIR = path.resolve("log");
const MAX_DAYS = 350;

// format date/time for file/folder names
const formatDate = (date) => {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return { dayStr: `${dd}.${mm}.${yyyy}`, year: `${yyyy}` };
};

// ensure log folder/file exists
async function ensureLogPath(year, dayStr) {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const yearPath = path.join(LOG_DIR, year);
    await fs.mkdir(yearPath, { recursive: true });

    const filePath = path.join(yearPath, dayStr);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, "");
    }
    return filePath;
  } catch (err) {
    console.error("Logger ensureLogPath error:", err.message);
    return null;
  }
}

// cleanup old logs beyond MAX_DAYS
async function cleanupLogs() {
  try {
    const years = await fs.readdir(LOG_DIR);
    let allFiles = [];

    for (const year of years) {
      const yearPath = path.join(LOG_DIR, year);
      const files = await fs.readdir(yearPath);
      files.forEach((f) => {
        allFiles.push({
          path: path.join(yearPath, f),
          name: f,
        });
      });
    }

    // sort by date ascending
    allFiles.sort((a, b) => {
      const [da, ma, ya] = a.name.split(".").map(Number);
      const [db, mb, yb] = b.name.split(".").map(Number);
      return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
    });

    while (allFiles.length > MAX_DAYS) {
      const oldest = allFiles.shift();
      try {
        await fs.unlink(oldest.path);
      } catch (e) {
        console.error("Logger cleanup error:", e.message);
      }
    }
  } catch {
    // ignore errors — e.g., log dir not created yet
  }
}

// core logger
const log = async (level, message, notify = false) => {
  try {
    const now = await getSwissTime();
    const { dayStr, year } = formatDate(now);

    const filePath = await ensureLogPath(year, dayStr);
    if (!filePath) return;

    const timestamp = now.toISOString();
    const entry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    await fs.appendFile(filePath, entry);

    cleanupLogs().catch(() => {});

    // Always notify on ERROR, or if notify=true
    if (level === "error" || notify) {
      notifyHS(message);
    }
  } catch (err) {
    console.error("Logger write error:", err.message);
  }
};

// exported logger API
const logger = {
  debug: (msg, notify = false) => log("debug", msg, notify),
  info: (msg, notify = false) => log("info", msg, notify),
  warn: (msg, notify = false) => log("warn", msg, notify),
  error: (msg) => log("error", msg, true), // always notifies
};

export default logger;
