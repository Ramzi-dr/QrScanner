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
  return { dayStr: `${dd}.${mm}.${yyyy}`, year: `${yyyy}`, month: `${mm}` };
};

// ensure log folder/file exists (log/<year>/<month>/<dd.mm.yyyy>)
async function ensureLogPath(year, month, dayStr) {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });

    const yearPath = path.join(LOG_DIR, year);
    await fs.mkdir(yearPath, { recursive: true });

    const monthPath = path.join(yearPath, month);
    await fs.mkdir(monthPath, { recursive: true });

    const filePath = path.join(monthPath, dayStr);
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
    const years = await fs.readdir(LOG_DIR, { withFileTypes: true });
    const allFiles = [];

    for (const yDirent of years) {
      if (!yDirent.isDirectory()) continue;
      const yearPath = path.join(LOG_DIR, yDirent.name);

      const months = await fs.readdir(yearPath, { withFileTypes: true });
      for (const mDirent of months) {
        if (!mDirent.isDirectory()) continue;
        const monthPath = path.join(yearPath, mDirent.name);

        const files = await fs.readdir(monthPath, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          const name = f.name;

          // expect dd.mm.yyyy as filename
          const parts = name.split(".");
          if (parts.length !== 3) continue;
          const [dd, mm, yyyy] = parts.map(Number);
          if (
            Number.isNaN(dd) ||
            Number.isNaN(mm) ||
            Number.isNaN(yyyy) ||
            dd < 1 ||
            dd > 31 ||
            mm < 1 ||
            mm > 12
          ) {
            continue;
          }

          allFiles.push({
            path: path.join(monthPath, name),
            name,
          });
        }
      }
    }

    // sort by date ascending based on dd.mm.yyyy filename
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
    const { dayStr, year, month } = formatDate(now);

    const filePath = await ensureLogPath(year, month, dayStr);
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
