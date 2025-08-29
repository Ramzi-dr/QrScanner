// shelly.js — webhook to update access.json from Shelly input events

import dotenv from "dotenv";
dotenv.config();
import express from "express";
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import logger from "./logger.js";
import { setShellyOutput } from "./shellyOutputs.js";
import { updateAccessFile } from "./state.js";
import { startDoorTracker } from "./doorTracker.js";
import { createBookmark } from "./wisenetBookmark.js";

dotenv.config({ quiet: true });

const router = express.Router();
router.use(
  express.json({ limit: "32kb", strict: true, type: "application/json" }),
);

const FILE = path.resolve("./access.json");

// env mappings (defaults: button=0, door=1, reserve=2)
const EXIT_BUTTON_INPUT_ID = Number(process.env.EXIT_BUTTON_INPUT_ID ?? 0);
const DOOR_STATE_INPUT_ID  = Number(process.env.DOOR_STATE_INPUT_ID ?? 1);
const RESERVE_INPUT_ID     = Number(process.env.RESERVE_INPUT_ID ?? 2);

const SHELLY_CALLBACK_PATH = process.env.SHELLY_CALLBACK_PATH || "/shelly";

// window for "Exit granted" log (door opens shortly after button press)
// ✅ now configured in SECONDS (default 3s)
const EXIT_GRANT_WINDOW_SEC = Number(process.env.EXIT_GRANT_WINDOW_SEC ?? 3);
const EXIT_GRANT_WINDOW_MS  = EXIT_GRANT_WINDOW_SEC * 1000;

// track last exit button press
let lastExitPressTs = 0;

// ---------- helpers ----------
const defaultAccessObj = () => ({
  button: { exitButtonPressed: false },
  door: { doorState: "Close" },
  reserveInput: { inputState: "off" },
  accessControle: { accessState: "noAccess" },
});

async function readFileSafe() {
  try {
    if (fssync.existsSync(FILE)) {
      const txt = await fs.readFile(FILE, "utf8");
      return JSON.parse(txt || "{}");
    }
  } catch (e) {
    logger.error(`read access.json failed: ${e.stack || e.message}`);
  }
  return null;
}

async function writeFileSafe(obj) {
  try {
    const tmp = FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fs.rename(tmp, FILE);
  } catch (e) {
    logger.error(`write access.json failed: ${e.stack || e.message}`);
  }
}

/**
 * only patch the sub-object for the given input
 * NOTE: Door input logic flipped:
 *   close contact (true)  => door is "Close"
 *   open  contact (false) => door is "Open"
 */
function applyInputPatch(current, inputNum, stateBool) {
  const patched = { ...current };

  if (!patched.button) patched.button = { exitButtonPressed: false };

  if (inputNum === EXIT_BUTTON_INPUT_ID) {
    patched.button = {
      ...(current.button || {}),
      exitButtonPressed: !!stateBool,
    };
  } else if (inputNum === DOOR_STATE_INPUT_ID) {
    // 🔁 FLIPPED MAPPING HERE
    patched.door = {
      ...(current.door || {}),
      doorState: stateBool ? "Close" : "Open",
    };
  } else if (inputNum === RESERVE_INPUT_ID) {
    patched.reserveInput = {
      ...(current.reserveInput || {}),
      inputState: stateBool ? "on" : "off",
    };
  }

  return patched;
}

// POST <callback>
router.post(SHELLY_CALLBACK_PATH, async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    if (!events.length) {
      res.status(400).send("Empty body");
      return;
    }

    let accessObj = await readFileSafe();
    if (!accessObj) {
      Promise.resolve()
        .then(() => updateAccessFile())
        .catch((e) =>
          logger.error(
            `background updateAccessFile failed: ${e.stack || e.message}`,
          ),
        );
      accessObj = defaultAccessObj();
    }

    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;

      const inputNum = Number(ev.input ?? ev.id);
      const stateBool = !!(ev.state ?? ev.value);
      if (!Number.isFinite(inputNum)) continue;

      // required logs only
      if (inputNum === EXIT_BUTTON_INPUT_ID && stateBool === true) {
        console.log("Exit button pressed");
        logger.info("Exit button pressed");
        lastExitPressTs = Date.now();
      }

      // With flipped mapping, DOOR OPEN == stateBool === false
      if (inputNum === DOOR_STATE_INPUT_ID && stateBool === false) {
        const now = Date.now();
        const delta = now - lastExitPressTs;
        if (delta <= EXIT_GRANT_WINDOW_MS) {
          logger.info("Exit granted");
          // 🔖 Fire-and-forget German bookmark for granted exit
          Promise.resolve()
            .then(() =>
              createBookmark({
                name: "✅ Ausgang gewährt",
                message: "✅ Ausgang gewährt: Türöffnung nach Exit-Taste",
                tags: ["TÜR", "EXIT", "GRANTED"],
              }),
            )
            .catch((e) =>
              logger.error(
                `createBookmark (Exit granted) failed: ${e?.message || e}`,
              ),
            );
          lastExitPressTs = 0;
        }
      }

      // update state objects
      accessObj = applyInputPatch(accessObj, inputNum, stateBool);

      // With flipped mapping, DOOR CLOSE == stateBool === true
      if (inputNum === DOOR_STATE_INPUT_ID && stateBool === true) {
        if (!accessObj.accessControle)
          accessObj.accessControle = { accessState: "noAccess" };
        accessObj.accessControle.accessState = "noAccess";
      }

      // preserve relay behavior on exit button press (non-blocking)
      if (inputNum === EXIT_BUTTON_INPUT_ID && stateBool === true) {
        Promise.resolve()
          .then(() => setShellyOutput(0, true))
          .catch(() => {});
      }
    }

    await writeFileSafe(accessObj);
    res.sendStatus(200);
  } catch (err) {
    logger.error(`Shelly webhook handler error: ${err.stack || err.message}`);
    res.status(400).send("Bad event format");
  }
});

// background watchdog
startDoorTracker();

export default router;
