// timeHelper.js
import logger from "./logger.js";

/**
 * Always return Swiss time (Europe/Zurich).
 * - Uses system clock
 * - Formats into Zurich timezone
 * - Logs system timezone vs Zurich timezone once (info)
 * - Logs only errors/warnings if something fails
 * - Never throws, always returns a Date
 */
let loggedOnce = false;

const getSwissTime = async () => {
  try {
    const now = new Date();

    // Format into Zurich time
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Zurich",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = fmt.formatToParts(now).reduce((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});

    const swissDate = new Date(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`
    );

    if (!loggedOnce) {
      loggedOnce = true;
      logger.info(`System timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
      logger.info("Using forced timezone: Europe/Zurich");
    }

    return swissDate;
  } catch (err) {
    logger.error(`Swiss time conversion failed: ${err.message}`);
    return new Date(); // fallback to system time
  }
};

export default getSwissTime;
