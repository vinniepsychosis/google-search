// browser.ts
//
// A single stealth-patched Chromium, shared by every launch in this project.
//
// `playwright-extra` is a drop-in replacement for `playwright` that augments the
// installed Playwright with plugin support. We register `puppeteer-extra-plugin-stealth`
// (playwright-extra is compatible with most puppeteer-extra plugins), which applies a
// broad suite of evasions on every launch — navigator.webdriver, plugins/mimeTypes,
// languages, WebGL vendor/renderer, chrome runtime, permissions, iframe.contentWindow,
// and more — far more thorough than a hand-rolled addInitScript. This is the same
// stealth approach used to scrape Bing/Google without immediately tripping bot
// detection. Import { chromium } from "./browser.js" instead of from "playwright".

import { chromium as chromiumExtra } from "playwright-extra";
// puppeteer-extra-plugin-stealth ships CJS with a default-export factory.
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Register the plugin exactly once (module singleton). `use()` is idempotent per plugin
// name, so importing this module from multiple files is safe.
chromiumExtra.use(StealthPlugin());

export const chromium = chromiumExtra;
