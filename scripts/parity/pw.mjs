// Shared headless-Chromium helper (playwright-core from /project/aftercard, browser from /project/.work/browsers).
import { chromium } from "/project/aftercard/node_modules/playwright-core/index.mjs";
import { readdirSync } from "node:fs";
const root = "/project/.work/browsers/chromium_headless_shell-1248";
export const EXE = process.env.EXE ?? `${root}/${readdirSync(root).find((d) => d.startsWith("chrome-"))}/chrome-headless-shell`;
export const launch = () => chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
