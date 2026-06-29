#!/usr/bin/env node
// Restore / seed tc_memory.knowledge from an /api/export snapshot.
// Doubles as (a) backup-restore and (b) seeding a local replica for eval.
//
// The target schema must already exist (start the server once against the target
// DATABASE_URL so initDb() runs, or apply init.sql). Rows are upserted by id; the
// search_vector is (re)computed by the table trigger on insert.
//
// Usage:
//   node scripts/seed-from-export.mjs --in snapshot.json --db postgresql://localhost/tcmem_eval
//   curl -s -H "Authorization: Bearer $TC_MEMORY_TOKEN" https://memory.team-clash.com/api/export > snapshot.json

import { readFileSync } from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : undefined; };
const inFile = get("--in");
const dbUrl = get("--db") || process.env.DATABASE_URL;

if (!inFile || !dbUrl) {
  console.error("usage: node scripts/seed-from-export.mjs --in <export.json> --db <DATABASE_URL>");
  process.exit(2);
}

const snap = JSON.parse(readFileSync(inFile, "utf8"));
const entries = snap.entries || snap;
console.log(`seeding ${entries.length} entries into ${dbUrl.replace(/:[^:@/]*@/, ":***@")}`);

const pool = new pg.Pool({ connectionString: dbUrl });

const main = async () => {
  let n = 0;
  for (const e of entries) {
    await pool.query(
      `INSERT INTO tc_memory.knowledge
         (id, topic, content, source, tags, confidence, user_id, access_count, last_accessed, memory_type, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         topic=EXCLUDED.topic, content=EXCLUDED.content, source=EXCLUDED.source, tags=EXCLUDED.tags,
         confidence=EXCLUDED.confidence, user_id=EXCLUDED.user_id, access_count=EXCLUDED.access_count,
         last_accessed=EXCLUDED.last_accessed, memory_type=EXCLUDED.memory_type,
         created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
      [e.id, e.topic, e.content, e.source, e.tags ?? [], e.confidence ?? 1.0, e.user_id ?? "unknown",
       e.access_count ?? 0, e.last_accessed ?? null, e.memory_type ?? "pattern",
       e.created_at ?? new Date().toISOString(), e.updated_at ?? new Date().toISOString()]
    );
    n++;
  }
  // keep the serial sequence ahead of the max restored id
  await pool.query(`SELECT setval(pg_get_serial_sequence('tc_memory.knowledge','id'), (SELECT MAX(id) FROM tc_memory.knowledge))`);
  console.log(`done: ${n} rows upserted`);
  await pool.end();
};

main().catch((e) => { console.error(e); process.exit(1); });
