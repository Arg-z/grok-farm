// Baca OpenClaw agent sqlite untuk lihat usage data
const Database = require("better-sqlite3");
const path = "C:\\Users\\Arga\\.openclaw\\agents\\main\\agent\\openclaw-agent.sqlite";
const db = new Database(path, { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("TABLES:", tables.map((t) => t.name));

for (const t of tables) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get();
    console.log(`\n=== ${t.name} (${count.c} rows) ===`);
    const sample = db.prepare(`SELECT * FROM "${t.name}" LIMIT 2`).all();
    for (const row of sample) {
      const s = JSON.stringify(row);
      console.log(s.slice(0, 500));
    }
  } catch (e) {
    console.log(`${t.name}: ${e.message}`);
  }
}

db.close();
