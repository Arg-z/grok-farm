// save.js — SAVE phase: simpan cookies/<email>.json
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { ROOT } from "./state.js";

export function simpanCookies(config, akun) {
  const dir = join(ROOT, config.cookiesDir || "cookies");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${akun.email}.json`);
  const storage = akun.storage || { cookies: [], origins: [] };
  writeFileSync(path, JSON.stringify(storage, null, 2));
  return path;
}
