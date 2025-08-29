// index.js
import { startServer } from "./express.js";
import { startHeartbeat } from "./heartbeat.js";
import { updateDST } from "./dstAuto.js";
import { updateAccessFile } from "./state.js";
import logger from "./logger.js";
import getSwissTime from "./timeHelper.js";
import { configureShelly } from "./configureShelly.js";
import { setAllShellyOutputsOff } from "./shellyAllOff.js";
import { configureQrScanner } from "./configureQrScanner.js";

/**
 * Schedule a task daily at a specific Swiss time (HH:MM).
 * - Uses Swiss time from timeHelper
 * - Recalculates next run each day (DST-safe)
 * - Always wrapped in try/catch to avoid crashes
 */
function scheduleDaily(taskFn, hour = 2, minute = 0) {
  const scheduleNext = async () => {
    try {
      const now = await getSwissTime();
      const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        hour,
        minute,
        0,
        0,
      );

      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      const delay = next - now;
      logger.info(
        `Next scheduled task at ${next.toLocaleString("de-CH", {
          timeZone: "Europe/Zurich",
        })}`,
      );

      setTimeout(async () => {
        try {
          await taskFn();
          logger.info(`Task executed successfully: ${taskFn.name}`);
        } catch (err) {
          logger.error(`Task failed: ${taskFn.name} - ${err.stack || err.message}`);
        }
        // reschedule no matter what
        scheduleNext();
      }, delay);
    } catch (err) {
      logger.error(`Scheduling error: ${taskFn.name} - ${err.stack || err.message}`);
      // retry scheduling in 1 min if calculation itself fails
      setTimeout(scheduleNext, 60 * 1000);
    }
  };

  scheduleNext();
}

// === Startup ===
(async () => {
  try {
    updateDST();

    scheduleDaily(updateDST, 2, 0);

    try {
      await updateAccessFile();
      logger.info("✅ access.json initialized");
    } catch (err) {
      logger.error(`Failed to initialize access.json: ${err.stack || err.message}`);
    }

    // 🚀 Start services
    try {
      startServer();
      logger.info("✅ Server started");

      // 📡 Configure Hikvision HTTP host (non-blocking)
      try {
        configureQrScanner();
        logger.info("📡 configureQrScanner kicked off");
        configureShelly();
        logger.info("📡 configureShelly kicked off");
        setAllShellyOutputsOff();
        logger.info("📡 setAllShellyOutputsOff kicked off");
      } catch (e) {
        logger.error(`configureQrScanner kickoff failed: ${e.stack || e.message}`);
      }
    } catch (err) {
      logger.error(`Server startup failed: ${err.stack || err.message}`);
    }

    try {
      startHeartbeat();
      logger.info("💓 Heartbeat started");
    } catch (err) {
      logger.error(`Heartbeat startup failed: ${err.stack || err.message}`);
    }
  } catch (err) {
    logger.error(`Fatal startup error: ${err.stack || err.message}`);
    process.exit(1);
  }
})();

// Global last-resort safety nets
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled Promise Rejection: ${reason}`);
});
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
});
