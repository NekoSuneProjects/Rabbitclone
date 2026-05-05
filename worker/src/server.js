const express = require("express");
const pino = require("pino");
const { chromium } = require("playwright-core");

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();

const PORT = Number(process.env.PORT || 3001);
const START_URL = process.env.START_URL || "https://example.com/";
const VIEWPORT = process.env.VIEWPORT || process.env.CAPTURE_SIZE || "1280x720";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

let browser;
let page;
let currentUrl = START_URL;

function parseViewport(value) {
  const [width, height] = String(value).split("x").map((part) => Number(part));
  return {
    width: Number.isFinite(width) ? width : 1280,
    height: Number.isFinite(height) ? height : 720
  };
}

async function ensureBrowser() {
  if (browser && page) return page;

  const viewport = parseViewport(VIEWPORT);
  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--autoplay-policy=no-user-gesture-required",
      "--kiosk",
      `--window-size=${viewport.width},${viewport.height}`
    ]
  });

  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: true
  });

  page = await context.newPage();
  page.on("console", (message) => log.debug({ text: message.text() }, "browser console"));
  page.on("pageerror", (error) => log.warn({ error: error.message }, "browser page error"));
  await navigateTo(currentUrl);
  return page;
}

async function navigateTo(url) {
  currentUrl = url;
  if (!page) return;
  log.info({ url }, "navigating room browser");
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000
  });
}

app.use(express.json());

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    roomId: process.env.ROOM_ID || null,
    url: currentUrl
  });
});

app.post("/navigate", async (req, res, next) => {
  try {
    const url = new URL(String(req.body.url || ""));
    if (!["http:", "https:"].includes(url.protocol)) {
      return res.status(400).json({ error: "Only http and https URLs are supported." });
    }
    await ensureBrowser();
    await navigateTo(url.toString());
    res.json({ ok: true, url: currentUrl });
  } catch (error) {
    next(error);
  }
});

app.use((err, req, res, next) => {
  log.error({ err }, "worker request failed");
  res.status(500).json({ error: err.message || "Worker error" });
});

process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit(0);
});

ensureBrowser().catch((error) => {
  log.error({ err: error }, "failed to launch browser");
});

app.listen(PORT, () => {
  log.info({ port: PORT }, "worker api listening");
});

