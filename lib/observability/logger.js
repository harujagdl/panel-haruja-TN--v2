import { randomUUID } from "node:crypto";

const TRACE_ID_PREFIX = "tr";

function normalizeString(value) {
  const parsed = String(value || "").trim();
  return parsed || undefined;
}

function sanitizeMeta(meta = {}) {
  const safeMeta = {};
  Object.entries(meta || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (key.toLowerCase().includes("token")) return;
    if (key.toLowerCase().includes("cookie")) return;
    safeMeta[key] = value;
  });
  return safeMeta;
}

function baseEntry(level, event, meta = {}) {
  return {
    level,
    event: normalizeString(event) || "app.event",
    timestamp: new Date().toISOString(),
    ...sanitizeMeta(meta),
  };
}

function writeLog(method, entry) {
  const payload = JSON.stringify(entry);
  method(payload);
}

export function logInfo(event, meta = {}) {
  writeLog(console.info, baseEntry("info", event, meta));
}

export function logWarn(event, meta = {}) {
  writeLog(console.warn, baseEntry("warn", event, meta));
}

export function logError(event, meta = {}) {
  writeLog(console.error, baseEntry("error", event, meta));
}

export function createTraceId(seed = "") {
  const rawSeed = normalizeString(seed);
  if (rawSeed) return rawSeed.slice(0, 48);
  const raw = randomUUID().replace(/-/g, "").slice(0, 12);
  return `${TRACE_ID_PREFIX}-${raw}`;
}

export function getErrorMessage(error) {
  return normalizeString(error?.message || error) || "Error desconocido";
}
