// qrScanner.js
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import multer from "multer";
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import logger from "./logger.js";
import { checkAccess } from "./checkAccess.js";

const router = express.Router();

const QR_CALLBACK_PATH = process.env.QR_CALLBACK_PATH || "/qrScanner";
const upload = multer();
const FILE = path.resolve("./access.json");

// ✅ Timings now in SECONDS (defaults: age=9s, future=3s, dedup=5s)
const EVENT_MAX_AGE_SEC    = Number(process.env.EVENT_MAX_AGE_SEC ?? 9);
const EVENT_MAX_FUTURE_SEC = Number(process.env.EVENT_MAX_FUTURE_SEC ?? 3);
const DEDUP_SEC            = Number(process.env.EVENT_DEDUP_SEC ?? 5);

const EVENT_MAX_AGE_MS    = EVENT_MAX_AGE_SEC * 1000;
const EVENT_MAX_FUTURE_MS = EVENT_MAX_FUTURE_SEC * 1000;
const DEDUP_MS            = DEDUP_SEC * 1000;

// Parse MAX_PENDING safely (fallback = 2)
const parsedMax = parseInt(process.env.MAX_PENDING_COUNTER, 10);
const MAX_PENDING = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 2;

// dedup map
const recentCards = new Map();

// default object created when file missing/corrupt
const defaultAccessObj = () => ({
  button: { exitButtonPressed: false },
  door: { doorState: "Close" },
  reserveInput: { inputState: "off" },
  accessControle: { accessState: "noAccess" },
});

async function ensureFile() {
  try {
    if (!fssync.existsSync(FILE)) {
      const def = defaultAccessObj();
      await fs.writeFile(FILE, JSON.stringify(def, null, 2));
      return def;
    }

    const raw = await fs.readFile(FILE, "utf8").catch(() => "");
    if (!raw) {
      const def = defaultAccessObj();
      await fs.writeFile(FILE, JSON.stringify(def, null, 2));
      return def;
    }

    try {
      return JSON.parse(raw);
    } catch {
      let fixed = raw.replace(/^\uFEFF/, "");
      fixed = fixed.replace(/,\s*([}\]])/g, "$1");
      fixed = fixed.replace(/,\s*,+/g, ",");

      try {
        const obj = JSON.parse(fixed);
        const tmp = FILE + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
        await fs.rename(tmp, FILE);
        await logger.warn("access.json was malformed; auto-corrected and saved", true);
        return obj;
      } catch (e2) {
        await logger.error(`access.json parse failed after auto-fix: ${e2.message}`);
        const def = defaultAccessObj();
        const tmp = FILE + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(def, null, 2));
        await fs.rename(tmp, FILE);
        return def;
      }
    }
  } catch (e) {
    logger.error(`ensureFile failed: ${e.stack || e.message}`);
    return defaultAccessObj();
  }
}

async function writeFileSafe(obj) {
  try {
    const tmp = FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fs.rename(tmp, FILE);
  } catch (e) {
    logger.error(`writeFileSafe failed: ${e.stack || e.message}`);
  }
}

router.post(
  QR_CALLBACK_PATH,
  (req, res, next) => {
    if (req.is("multipart/form-data")) return upload.any()(req, res, next);
    return express.json()(req, res, next);
  },
  async (req, res) => {
    try {
      const raw = req.body?.AccessControllerEvent ?? req.body ?? {};
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const ev = parsed?.AccessControllerEvent ?? parsed ?? {};
      const now = Date.now();

      if (ev.eventType === "heartBeat") return res.send("OK");

      // Extract event time
      const eventTimeStr =
        ev.dateTime || ev.eventTime || ev.time || parsed.dateTime || parsed.eventTime;
      const eventTime = Date.parse(eventTimeStr);

      if (Number.isNaN(eventTime)) {
        logger.warn("⛔ Rejected event (invalid/missing dateTime)");
        return res.send("OK");
      }

      // ✅ Explicit age calculation
      const ageMs = now - eventTime;
      if (ageMs > EVENT_MAX_AGE_MS) {
        logger.warn(`⛔ Rejected too-old event | age>${EVENT_MAX_AGE_SEC}s`);
        return res.send("OK");
      }
      if (eventTime > now + EVENT_MAX_FUTURE_MS) {
        logger.warn(`⛔ Rejected future event | skew>${EVENT_MAX_FUTURE_SEC}s`);
        return res.send("OK");
      }

      const card =
        ev.cardNo || ev.cardNumber || ev.qrCode || ev.QRCodeInfo || ev.qrCodeInfo;

      if (!card) {
        return res.send("OK");
      }

      const last = recentCards.get(card);
      if (last && now - last < DEDUP_MS) {
        logger.warn(`⛔ Rejected duplicate within ${DEDUP_SEC}s: ${card}`);
        return res.send("OK");
      }
      recentCards.set(card, now);

      let obj = await ensureFile();
      if (!obj.accessControle) obj.accessControle = { accessState: "noAccess" };

      if (obj.accessControle.accessState === "pending") {
        if (typeof obj.accessControle.pendingCounter !== "number") {
          obj.accessControle.pendingCounter = 1;
          await writeFileSafe(obj);
          return res.send("OK");
        }

        if (obj.accessControle.pendingCounter < MAX_PENDING) {
          obj.accessControle.pendingCounter++;
          await writeFileSafe(obj);
          return res.send("OK");
        }

        logger.error(
          `Access still pending after ${MAX_PENDING} retries → there is a request sent to Spaeter server but still pending`,
          true
        );

        obj.accessControle.pendingCounter = 0;
        await writeFileSafe(obj);

        Promise.resolve()
          .then(() => checkAccess(card))
          .catch((e) => logger.error(`checkAccess failed: ${e.stack || e.message}`));
      } else {
        obj.accessControle.accessState = "pending";
        obj.accessControle.pendingCounter = 1;
        await writeFileSafe(obj);

        Promise.resolve()
          .then(() => checkAccess(card))
          .catch((e) => logger.error(`checkAccess failed: ${e.stack || e.message}`));
      }

      res.send("OK");
    } catch (err) {
      logger.error(`❌ Failed to handle QR event: ${err.stack || err.message}`);
      res.status(400).send("Bad event format");
    }
  }
);

export default router;
