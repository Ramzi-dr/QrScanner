// doorTracker.js — background watchdog
// ✅ Console/Logger: ENGLISH ONLY
// ✅ Bookmarks: GERMAN
// ✅ If door open is authorized (access granted OR exit button pressed recently), NEVER flag unauthorized.
// ✅ Long-open alarms still fire.
// ✅ Robust: pressing exit while the door is already open immediately authorizes the current open cycle.
// NOTE: This tracker relies on access.json -> door.doorState being "Open"/"Close".
//       With the flipped input mapping done in shelly.js (true => "Close", false => "Open"),
//       no further changes are needed here.

import dotenv from "dotenv";
dotenv.config();
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import logger from "./logger.js";
import { createBookmark } from "./wisenetBookmark.js";

dotenv.config({ quiet: true });

const FILE = path.resolve("./access.json");

// thresholds (seconds)
const MAX_TIME_DOOR_OPEN_SEC = Number(process.env.MAX_TIME_DOOR_OPEN ?? 300); // first alarm threshold
const MIN_ILLEGAL_OPEN_SEC   = Number(process.env.MIN_ILLEGAL_OPEN_SEC ?? 2); // ignore very short opens
const EXIT_GRACE_SEC         = Number(process.env.EXIT_GRACE_SEC ?? 10);     // exit press valid window

let doorOpenedAt = null;
let nextAlarmAt = null;
let unauthorizedWarned = false;

let lastExitButtonAt = 0;        // last time exitButtonPressed was true
let openCycleAuthorized = false; // latched authorization for the current open cycle

async function readFileSafe() {
  try {
    if (fssync.existsSync(FILE)) {
      const txt = await fs.readFile(FILE, "utf8");
      return JSON.parse(txt || "{}");
    }
  } catch (e) {
    logger.error(`read access.json failed in doorTracker: ${e.stack || e.message}`);
  }
  return null;
}

// EN for console/logger
function formatDurationEN(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} seconds`;
  if (r === 0) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  return `${m} ${m === 1 ? "minute" : "minutes"} and ${r} seconds`;
}

// DE for bookmarks
function formatDurationDE(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} Sekunden`;
  if (r === 0) return `${m} ${m === 1 ? "Minute" : "Minuten"}`;
  return `${m} ${m === 1 ? "Minute" : "Minuten"} und ${r} Sekunden`;
}

export function startDoorTracker() {
  setInterval(async () => {
    try {
      const obj = await readFileSafe();
      if (!obj || !obj.door || !obj.accessControle || !obj.button) return;

      const now = Date.now();
      const isOpen = obj.door.doorState === "Open"; // uses flipped mapping from shelly.js
      const accessState = obj.accessControle.accessState;
      const accessGrantedNow = accessState !== "noAccess" && accessState !== "pending";

      // Track exit button recency and IMMEDIATELY authorize the open cycle if door is open
      if (obj.button.exitButtonPressed === true) {
        lastExitButtonAt = now;
        if (isOpen) {
          openCycleAuthorized = true; // pressing while open should authorize this cycle right away
        }
      }
      const exitPressedRecently = now - lastExitButtonAt <= EXIT_GRACE_SEC * 1000;

      if (isOpen) {
        // Closed -> Open transition
        if (!doorOpenedAt) {
          doorOpenedAt = now;
          nextAlarmAt = doorOpenedAt + MAX_TIME_DOOR_OPEN_SEC * 1000;
          unauthorizedWarned = false;
          openCycleAuthorized = false; // reset for new cycle

          // If door just opened and there is a grant or recent exit press, authorize the cycle at start
          if (accessGrantedNow || exitPressedRecently) {
            openCycleAuthorized = true;
          }

          console.log("🚪 Door opened, watchdog tracking started...");
        }

        // While open: if not yet authorized, latch if a grant or recent exit press appears
        if (!openCycleAuthorized && (accessGrantedNow || exitPressedRecently)) {
          openCycleAuthorized = true;
        }

        const openForSec = Math.round((now - doorOpenedAt) / 1000);
        const openEN = formatDurationEN(openForSec);
        console.log(`⏱️ Door has been open for ${openEN}`);

        // Unauthorized detection — ONLY if the current open cycle is NOT authorized
        if (
          !openCycleAuthorized &&
          !unauthorizedWarned &&
          openForSec > MIN_ILLEGAL_OPEN_SEC &&
          !exitPressedRecently &&
          !accessGrantedNow
        ) {
          const openDE = formatDurationDE(openForSec);

          // EN logs only
          const enMsg = `⚠️ Unauthorized door opening detected (open for ${openEN}, no access, no exit button)`;
          logger.warn(enMsg);
          console.log(enMsg);

          // Bookmark in German
          await createBookmark({
            name: "⚠️ Unbefugter Zutritt",
            message: `⚠️ Unbefugtes Türöffnen erkannt (offen seit ${openDE}, kein Zutritt, kein Exit-Button)`,
            tags: ["TÜR", "UNAUTHORIZED", "ILLEGAL"],
            kvTags: { dauer: openDE },
          });

          unauthorizedWarned = true;
        }

        // Long-open alarms (independent of authorization)
        if (now >= nextAlarmAt) {
          const openDE = formatDurationDE(openForSec);
          const enWarn = `⚠️ WARNING: The door has been open for ${openEN}`;
          logger.warn(enWarn, true);
          console.log(`⛔ Alarm: ${enWarn}`);

          await createBookmark({
            name: "⚠️ Tür Warnung",
            message: `⚠️ WARNUNG: Die Tür ist seit ${openDE} offen`,
            tags: ["TÜR", "ALARM", "ZU_LANGE_OFFEN"],
            kvTags: { dauer: openDE },
          });

          // schedule next alarm step
          if (nextAlarmAt === doorOpenedAt + MAX_TIME_DOOR_OPEN_SEC * 1000) {
            nextAlarmAt = now + 15 * 60 * 1000; // next in 15 min
          } else {
            nextAlarmAt = now + 60 * 60 * 1000; // then every 1h
          }
        }
      } else {
        // Door closed → reset cycle flags & timers
        if (doorOpenedAt) {
          console.log("🚪 Door closed, watchdog reset.");
        }
        doorOpenedAt = null;
        nextAlarmAt = null;
        unauthorizedWarned = false;
        openCycleAuthorized = false;
      }
    } catch (e) {
      logger.error(`Door watchdog failed: ${e.stack || e.message}`);
    }
  }, 1000); // check every 1s
}
