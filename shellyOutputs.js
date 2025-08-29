// shellyOutputs.js — robust Shelly output control with Promise + error handling
import dotenv from "dotenv";
dotenv.config();
import { execFile } from "child_process";
import logger from "./logger.js";
dotenv.config({ quiet: true });
const IP = process.env.SHELLY_IP;
const PASSWORD = process.env.SHELLY_PASSWORD;
const USERNAME = "admin";
const TIMEOUT_MS = 4000;

/**
 * Set Shelly output ON/OFF with Digest auth.
 * Returns a Promise that resolves only on HTTP 200 OK.
 *
 * @param {number} outputId - Shelly output ID
 * @param {boolean} on - true = activate, false = deactivate
 * @returns {Promise<void>}
 */
export function setShellyOutput(outputId = 0, on = true) {
  return new Promise((resolve, reject) => {
    try {
      if (!IP || !PASSWORD) {
        const msg = "Shelly config missing: SHELLY_IP or SHELLY_PASSWORD";
        logger.error(msg);
        return reject(new Error(msg));
      }

      const url = `http://${IP}/rpc/Switch.Set?id=${outputId}&on=${on ? "true" : "false"}`;
      const args = ["-sv", "--digest", "-u", `${USERNAME}:${PASSWORD}`, url];

      const child = execFile("curl", args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
        try {
          const combined = `${stdout}\n${stderr}`;
          if (err) {
            const msg = `Shelly exec error: ${err.message}\n${combined}`;
            logger.error(msg);
            return reject(new Error(msg));
          }

          if (combined.includes("HTTP/1.1 200 OK")) {
            return resolve(); // success
          } else {
            const msg = `Shelly output ${outputId} failed\n${combined}`;
            logger.error(msg);
            return reject(new Error(msg));
          }
        } catch (e) {
          logger.error(`Shelly unexpected error: ${e.stack || e.message}`);
          return reject(e);
        }
      });

      child.on("error", (e) => {
        const msg = `Shelly process failed: ${e.message}`;
        logger.error(msg);
        reject(new Error(msg));
      });
    } catch (outer) {
      logger.error(`setShellyOutput fatal error: ${outer.stack || outer.message}`);
      reject(outer);
    }
  });
}
