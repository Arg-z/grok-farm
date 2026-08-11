// cek session transcript untuk usage data
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const dir = "C:\\Users\\Arga\\.openclaw\\agents\\main\\sessions";
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => join(dir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, 3); // 3 file terbaru

for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  console.log(`\n=== ${f} (${lines.length} lines) ===`);
  // Cari baris yang mengandung "usage" atau "tokens"
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.usage || obj.tokens || obj.token_count || obj.model) {
        console.log(JSON.stringify(obj).slice(0, 300));
      }
    } catch {}
  }
}
