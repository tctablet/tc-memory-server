#!/usr/bin/env node
// Golden-query retrieval eval for tc-memory.
// Hits the /api/search REST endpoint of any running instance (live or local)
// and reports hit@1 / hit@5 / hit@10 / MRR against scripts/golden-set.json.
//
// Usage:
//   TC_MEMORY_TOKEN=... node scripts/eval-recall.mjs                 # against live
//   BASE_URL=http://localhost:3333 TC_MEMORY_TOKEN=dev-token-change-me node scripts/eval-recall.mjs
//   ... --verbose        show per-query rank + what was returned
//
// Exit code is 0 always (it is a measurement, not a gate) unless --gate <mrr> is
// passed, in which case it exits 1 if MRR < threshold.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.BASE_URL || "https://memory.team-clash.com").replace(/\/$/, "");
const TOKEN = process.env.TC_MEMORY_TOKEN;
const VERBOSE = process.argv.includes("--verbose");
const gateIdx = process.argv.indexOf("--gate");
const GATE = gateIdx > -1 ? parseFloat(process.argv[gateIdx + 1]) : null;
const LIMIT = 10;

if (!TOKEN) {
  console.error("ERROR: TC_MEMORY_TOKEN env var required");
  process.exit(2);
}

const golden = JSON.parse(readFileSync(join(__dirname, "golden-set.json"), "utf8")).queries;

// Parse the plaintext /api/search response: each line is
//   [YYYY-MM-DD HH:MM] user:source | topic: content...
// Topic is the first non-space token after " | " and before ": ".
function topicsFromResponse(text) {
  if (!text || text === "No results") return [];
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/ \| (\S+?): /);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

async function search(query) {
  const url = `${BASE_URL}/api/search?query=${encodeURIComponent(query)}&limit=${LIMIT}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${query}"`);
  return topicsFromResponse(await res.text());
}

function firstHitRank(topics, accept) {
  for (let i = 0; i < topics.length; i++) {
    if (accept.includes(topics[i])) return i + 1; // 1-based
  }
  return 0; // miss
}

const main = async () => {
  let hit1 = 0, hit5 = 0, hit10 = 0, mrrSum = 0;
  const misses = [];
  console.log(`\n# tc-memory recall eval  →  ${BASE_URL}  (${golden.length} queries, limit ${LIMIT})\n`);

  for (const g of golden) {
    let topics = [];
    try {
      topics = await search(g.query);
    } catch (e) {
      console.log(`  ERR  ${g.query} :: ${e.message}`);
      misses.push(g.query);
      continue;
    }
    const rank = firstHitRank(topics, g.accept);
    if (rank === 1) hit1++;
    if (rank >= 1 && rank <= 5) hit5++;
    if (rank >= 1 && rank <= 10) hit10++;
    if (rank >= 1) mrrSum += 1 / rank;
    else misses.push(g.query);

    if (VERBOSE) {
      const tag = rank === 0 ? "MISS " : rank === 1 ? "  @1 " : `  @${rank} `;
      console.log(`${tag} [${g.lang}/${g.kind}] ${g.query}`);
      if (rank === 0) console.log(`        want one of: ${g.accept.join(", ")}`);
      console.log(`        got: ${topics.slice(0, 5).join(", ") || "(none)"}`);
    }
  }

  const n = golden.length;
  const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;
  console.log(`\n## Results  (n=${n})`);
  console.log(`  hit@1 : ${hit1}/${n}  ${pct(hit1)}`);
  console.log(`  hit@5 : ${hit5}/${n}  ${pct(hit5)}`);
  console.log(`  hit@10: ${hit10}/${n}  ${pct(hit10)}`);
  console.log(`  MRR   : ${(mrrSum / n).toFixed(4)}`);
  if (misses.length) {
    console.log(`\n  ${misses.length} misses:`);
    for (const m of misses) console.log(`    - ${m}`);
  }
  console.log("");

  if (GATE !== null) {
    const mrr = mrrSum / n;
    if (mrr < GATE) {
      console.error(`GATE FAILED: MRR ${mrr.toFixed(4)} < ${GATE}`);
      process.exit(1);
    }
    console.log(`GATE PASSED: MRR ${mrr.toFixed(4)} >= ${GATE}`);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
