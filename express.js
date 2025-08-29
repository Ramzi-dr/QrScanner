// express.js
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import os from "os";
import shellyRoutes from "./shelly.js";
import qrScannerRoutes from "./qrScanner.js";
import logger from "./logger.js";

export function createApp() {
  const app = express();

  // Global middleware
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Routes
  app.use("/", shellyRoutes);
  app.use("/", qrScannerRoutes);

  // Health check
  app.get("/", (req, res) => res.send("Server is running..."));

  // 404 handler
  app.use((req, res, next) => {
    const msg = `Route not found: ${req.method} ${req.originalUrl}`;
    logger.warn(msg);
    res.status(404).json({ error: "Not Found", message: msg });
  });

  // Global error handler (JSON parse errors, thrown errors, etc.)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const details = err.stack || err.message || String(err);
    logger.error(`Express error (${status}) on ${req.method} ${req.originalUrl}: ${details}`);
    res.status(status).json({
      error: "Internal Server Error",
      message: process.env.NODE_ENV === "production" ? "Unexpected error" : details,
    });
  });

  return app;
}

export function startServer(port = process.env.SERVER_PORT || 3000) {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app
      .listen(port)
      .once("listening", () => {
        try {
          const nets = os.networkInterfaces();
          const addrs = [];
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
              if (net.family === "IPv4" && !net.internal) addrs.push(net.address);
            }
          }
          logger.info(`✅ Server running`);
          logger.info(`   Local:   http://localhost:${port}`);
          addrs.forEach((ip) => logger.info(`   Network: http://${ip}:${port}`));
          resolve({ app, server });
        } catch (e) {
          logger.error(`Post-start logging failed: ${e.stack || e.message}`);
          resolve({ app, server }); // server is up; don't fail start because of logging
        }
      })
      .once("error", (err) => {
        // Make start fail so runWithRetry in index.js can retry
        logger.warn(`Server listen error on port ${port}: ${err.stack || err.message}`);
        try { server.close(); } catch {}
        reject(err);
      });
  });
}
