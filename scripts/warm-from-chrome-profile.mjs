#!/usr/bin/env node
// Warm the shared anti-bot state file from a logged-in Chrome profile.
//
// Why: an anonymous Google session gets CAPTCHA'd and goes stale within minutes. An
// AUTHENTICATED session (a real logged-in Google account) is trusted far more and stays
// valid for weeks. This exports the account's cookies into the file every entry point
// already reads (~/.google-search-browser-state.json), so the CLI/API/MCP keep running
// headless and unchanged — just now signed in.
//
// How: we do NOT launch Chrome to do this. Playwright-launched Chrome isolates itself
// from the macOS Keychain "Chrome Safe Storage" key (password-store=basic), so it can't
// decrypt real cookies. Instead we read that key from the Keychain ourselves (one-time
// "Allow" prompt), derive the AES key, and decrypt the cookie DB directly.
//
// Usage: node scripts/warm-from-chrome-profile.mjs
//   env CHROME_PROFILE_DIR (default "Default") — which profile folder to read.

import { execFileSync } from "child_process";
import crypto from "crypto";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const HOME = os.homedir();
const SRC = path.join(HOME, "Library/Application Support/Google/Chrome");
const STATE = path.join(HOME, ".google-search-browser-state.json");
const PROFILE = process.env.CHROME_PROFILE_DIR || "Default";
const COOKIE_DB = path.join(SRC, PROFILE, "Cookies");

if (!fs.existsSync(COOKIE_DB)) {
  console.error(`No Cookies DB at ${COOKIE_DB}`);
  process.exit(1);
}

// 1) macOS Keychain key for Chrome cookie encryption (one-time "Allow" prompt).
let kcPassword;
try {
  kcPassword = execFileSync(
    "security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
    { encoding: "utf8" }
  ).trim();
} catch (e) {
  console.error("Could not read 'Chrome Safe Storage' from Keychain (click Allow if prompted).");
  process.exit(1);
}
// Chrome on macOS: PBKDF2-HMAC-SHA1(password, "saltysalt", 1003) -> 16-byte AES key.
const key = crypto.pbkdf2Sync(kcPassword, "saltysalt", 1003, 16, "sha1");
const IV = Buffer.alloc(16, " ");

// Chrome >= ~v130 prepends SHA256(host_key) (32 bytes) to the plaintext before the value.
function decrypt(enc) {
  if (enc.length < 3 || enc.slice(0, 3).toString() !== "v10") return null; // unencrypted/legacy
  const d = crypto.createDecipheriv("aes-128-cbc", key, IV);
  d.setAutoPadding(false);
  let out = Buffer.concat([d.update(enc.subarray(3)), d.final()]);
  const pad = out[out.length - 1]; // strip PKCS7
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
  if (out.length >= 32) out = out.subarray(32); // strip domain-hash prefix
  return out.toString("utf8");
}

// 2) Read cookie rows from a COPY of the DB (source is locked while Chrome runs).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gcookies-"));
const dbCopy = path.join(tmp, "Cookies");
fs.copyFileSync(COOKIE_DB, dbCopy);
const SEP = "\x1f";
const rows = execFileSync(
  "sqlite3",
  [
    "-newline", "\x1e", "-separator", SEP, dbCopy,
    "SELECT name, host_key, path, hex(encrypted_value), expires_utc, is_secure, is_httponly, samesite " +
      "FROM cookies WHERE host_key LIKE '%google%' OR host_key LIKE '%youtube%' OR host_key LIKE '%gstatic%'",
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);
fs.rmSync(tmp, { recursive: true, force: true });

const sameSiteMap = { "-1": "None", "0": "None", "1": "Lax", "2": "Strict" };
const cookies = [];
for (const line of rows.split("\x1e")) {
  if (!line.trim()) continue;
  const [name, host, cpath, encHex, expires, secure, httponly, samesite] = line.split(SEP);
  let value;
  try { value = decrypt(Buffer.from(encHex, "hex")); } catch { value = null; }
  if (value == null) continue;
  // Chrome expires_utc is microseconds since 1601-01-01; convert to Unix seconds.
  const exp = Number(expires) === 0 ? -1 : Math.floor(Number(expires) / 1e6 - 11644473600);
  cookies.push({
    name, value, domain: host, path: cpath || "/",
    expires: exp, httpOnly: httponly === "1", secure: secure === "1",
    sameSite: sameSiteMap[String(samesite)] || "Lax",
  });
}

fs.writeFileSync(STATE, JSON.stringify({ cookies, origins: [] }, null, 2));

const authNames = ["SAPISID", "__Secure-1PSID", "SID", "HSID", "SSID", "APISID"];
const gotAuth = authNames.filter((n) => cookies.some((c) => c.name === n));
console.log(`Exported ${cookies.length} cookies to ${STATE}`);
console.log(
  gotAuth.length
    ? `AUTH OK — logged-in markers decrypted: ${gotAuth.join(", ")}`
    : "WARNING: no auth cookies decrypted — check the profile/Keychain."
);
