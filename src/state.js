// state.js — baca/tulis grok_accounts.json (state machine akun)
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ACCOUNTS_FILE = join(ROOT, "grok_accounts.json");

export function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function saveAccounts(accounts) {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

// Status final yang dihitung "selesai" untuk resume
export const STATUS_SELESAI = new Set(["signed_up", "injected"]);
