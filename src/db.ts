import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Initialize schema and table
export async function initDb(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS tc_memory`);
  // Enable pg_trgm for fuzzy/trigram search fallback
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tc_memory.knowledge (
      id            SERIAL PRIMARY KEY,
      topic         TEXT NOT NULL,
      content       TEXT NOT NULL,
      source        TEXT NOT NULL,
      tags          TEXT[] DEFAULT '{}',
      confidence    REAL DEFAULT 1.0,
      search_vector TSVECTOR,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add user_id column if not exists (migration for existing deployments)
  await pool.query(`
    ALTER TABLE tc_memory.knowledge ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT 'unknown'
  `);
  // Phase 1: Access tracking + memory type classification
  await pool.query(`
    ALTER TABLE tc_memory.knowledge ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE tc_memory.knowledge ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE tc_memory.knowledge ADD COLUMN IF NOT EXISTS memory_type TEXT DEFAULT 'pattern'
  `);
  // CHECK constraint for memory_type (idempotent via DO block)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_memory_type'
      ) THEN
        ALTER TABLE tc_memory.knowledge
          ADD CONSTRAINT chk_memory_type
          CHECK (memory_type IN ('core', 'architecture', 'pattern', 'decision'));
      END IF;
    END $$
  `);
  // Create trigger to auto-update search_vector
  await pool.query(`
    CREATE OR REPLACE FUNCTION tc_memory.update_search_vector() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('german', COALESCE(NEW.topic, '')), 'A') ||
        setweight(to_tsvector('german', COALESCE(NEW.content, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(array_to_string(NEW.tags, ' '), '')), 'C');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_knowledge_search_vector'
      ) THEN
        CREATE TRIGGER trg_knowledge_search_vector
          BEFORE INSERT OR UPDATE ON tc_memory.knowledge
          FOR EACH ROW EXECUTE FUNCTION tc_memory.update_search_vector();
      END IF;
    END $$
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_search ON tc_memory.knowledge USING GIN(search_vector)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_source ON tc_memory.knowledge(source)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON tc_memory.knowledge(topic)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_created ON tc_memory.knowledge(created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON tc_memory.knowledge USING GIN(tags)
  `);
  // Trigram indexes for fuzzy search fallback
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_topic_trgm ON tc_memory.knowledge USING GIN(topic gin_trgm_ops)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_content_trgm ON tc_memory.knowledge USING GIN(content gin_trgm_ops)
  `);
  // Phase 1: Indexes for access tracking + memory type
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_last_accessed ON tc_memory.knowledge(last_accessed DESC NULLS LAST)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_memory_type ON tc_memory.knowledge(memory_type)
  `);
  // Phase 2: Create retention score SQL function
  await createRetentionScoreFunction();
  // Phase 1: One-time backfill — classify existing entries + seed last_accessed
  await pool.query(`
    UPDATE tc_memory.knowledge SET last_accessed = updated_at WHERE last_accessed IS NULL
  `);
  await pool.query(`
    UPDATE tc_memory.knowledge SET memory_type = 'core'
    WHERE memory_type = 'pattern'
      AND (topic ILIKE '%agent-rules%' OR topic ILIKE '%sheet-ids%'
           OR topic ILIKE '%api-key%' OR topic ILIKE '%credentials%'
           OR topic ILIKE '%deployment-id%')
  `);
  await pool.query(`
    UPDATE tc_memory.knowledge SET memory_type = 'architecture'
    WHERE memory_type = 'pattern'
      AND (topic ILIKE '%cms-api%' OR topic ILIKE '%gas-webhook%'
           OR topic ILIKE '%pricing%' OR topic ILIKE '%stripe-api%'
           OR topic ILIKE '%infrastructure%' OR topic ILIKE '%architecture%'
           OR topic ILIKE '%invoice-pdf%')
  `);
}

export type MemoryType = "core" | "architecture" | "pattern" | "decision";

export interface KnowledgeRow {
  id: number;
  topic: string;
  content: string;
  source: string;
  user_id: string;
  tags: string[];
  confidence: number;
  access_count: number;
  last_accessed: Date | null;
  memory_type: MemoryType;
  created_at: Date;
  updated_at: Date;
  rank?: number;
}

// Auto-classify memory type based on topic and tags
export function classifyMemoryType(topic: string, tags: string[]): MemoryType {
  const t = topic.toLowerCase();
  const allTags = tags.map((tag) => tag.toLowerCase());

  // Core: agent rules, sheet IDs, API keys, credentials — never decays
  if (
    t.includes("agent-rules") ||
    t.includes("sheet-ids") ||
    t.includes("api-key") ||
    t.includes("credentials") ||
    t.includes("deployment-id") ||
    allTags.includes("core")
  ) {
    return "core";
  }

  // Architecture: system design, APIs, webhooks, pricing logic
  if (
    t.includes("cms-api") ||
    t.includes("gas-webhook") ||
    t.includes("pricing") ||
    t.includes("stripe-api") ||
    t.includes("infrastructure") ||
    t.includes("architecture") ||
    t.includes("invoice-pdf") ||
    allTags.includes("architecture")
  ) {
    return "architecture";
  }

  // Decision: rationale records
  if (allTags.includes("decision") || t.includes("decision")) {
    return "decision";
  }

  // Default: reusable pattern
  return "pattern";
}

// Record access for search result IDs (fire-and-forget)
export async function recordAccess(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE tc_memory.knowledge
     SET access_count = access_count + 1, last_accessed = NOW()
     WHERE id = ANY($1)`,
    [ids]
  );
}

export async function saveKnowledge(
  topic: string,
  content: string,
  source: string,
  tags: string[],
  confidence: number,
  userId: string = "unknown",
  memoryType?: MemoryType
): Promise<number> {
  const resolvedType = memoryType ?? classifyMemoryType(topic, tags);

  // Duplicate check: same topic + source + similar content → update
  const existing = await pool.query<KnowledgeRow>(
    `SELECT id FROM tc_memory.knowledge
     WHERE topic = $1 AND source = $2 AND content = $3
     LIMIT 1`,
    [topic, source, content]
  );

  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE tc_memory.knowledge
       SET content = $1, tags = $2, confidence = $3, user_id = $4, memory_type = $5, updated_at = NOW()
       WHERE id = $6`,
      [content, tags, confidence, userId, resolvedType, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }

  const result = await pool.query<{ id: number }>(
    `INSERT INTO tc_memory.knowledge (topic, content, source, tags, confidence, user_id, memory_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [topic, content, source, tags, confidence, userId, resolvedType]
  );
  return result.rows[0].id;
}

export async function searchKnowledge(
  query: string,
  source?: string,
  tags?: string[],
  limit: number = 10
): Promise<KnowledgeRow[]> {
  const tsQuery = query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w + ":*")
    .join(" & ");

  let sql = `
    SELECT *, ts_rank(search_vector, to_tsquery('german', $1)) AS rank
    FROM tc_memory.knowledge
    WHERE search_vector @@ to_tsquery('german', $1)
  `;
  const params: (string | string[] | number)[] = [tsQuery];
  let paramIdx = 2;

  if (source) {
    sql += ` AND source = $${paramIdx}`;
    params.push(source);
    paramIdx++;
  }
  if (tags && tags.length > 0) {
    sql += ` AND tags && $${paramIdx}`;
    params.push(tags);
    paramIdx++;
  }

  sql += ` ORDER BY rank DESC LIMIT $${paramIdx}`;
  params.push(Math.min(limit, 50));

  const result = await pool.query<KnowledgeRow>(sql, params);

  // Track access for returned results
  if (result.rows.length > 0) {
    recordAccess(result.rows.map((r) => r.id)).catch(() => {});
  }

  // Fallback: split query into words, ILIKE match any word against topic/content
  if (result.rows.length === 0 && query.trim().length >= 2) {
    const words = query.split(/[\s\-_,;.]+/).filter((w) => w.length >= 3);
    if (words.length === 0) return [];

    const patterns = words.map((w) => `%${w}%`);

    let fuzzySql = `
      SELECT k.*,
        (SELECT COUNT(*)::float FROM unnest($1::text[]) AS pattern
         WHERE k.topic ILIKE pattern OR k.content ILIKE pattern
        ) / cardinality($1::text[]) AS rank
      FROM tc_memory.knowledge k
      WHERE k.topic ILIKE ANY($1) OR k.content ILIKE ANY($1)
    `;
    const fuzzyParams: (string[] | string | number)[] = [patterns];
    let fuzzyIdx = 2;

    if (source) {
      fuzzySql += ` AND k.source = $${fuzzyIdx}`;
      fuzzyParams.push(source);
      fuzzyIdx++;
    }
    if (tags && tags.length > 0) {
      fuzzySql += ` AND k.tags && $${fuzzyIdx}`;
      fuzzyParams.push(tags);
      fuzzyIdx++;
    }

    fuzzySql += ` ORDER BY rank DESC LIMIT $${fuzzyIdx}`;
    fuzzyParams.push(Math.min(limit, 50));

    const fuzzyResult = await pool.query<KnowledgeRow>(fuzzySql, fuzzyParams);
    if (fuzzyResult.rows.length > 0) {
      recordAccess(fuzzyResult.rows.map((r) => r.id)).catch(() => {});
    }
    return fuzzyResult.rows;
  }

  return result.rows;
}

export async function getRecentChanges(
  hours: number = 48,
  source?: string,
  limit: number = 20
): Promise<KnowledgeRow[]> {
  let sql = `
    SELECT * FROM tc_memory.knowledge
    WHERE created_at > NOW() - INTERVAL '1 hour' * $1
  `;
  const params: (string | number)[] = [hours];
  let paramIdx = 2;

  if (source) {
    sql += ` AND source = $${paramIdx}`;
    params.push(source);
    paramIdx++;
  }

  sql += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
  params.push(Math.min(limit, 50));

  const result = await pool.query<KnowledgeRow>(sql, params);
  return result.rows;
}

export async function listTopics(
  source?: string
): Promise<{ topic: string; count: number; last_updated: Date; sources: string[]; avg_retention: number }[]> {
  let sql = `
    SELECT topic,
           COUNT(*)::int AS count,
           MAX(updated_at) AS last_updated,
           array_agg(DISTINCT source) AS sources,
           ROUND(AVG(tc_memory.retention_score(confidence, access_count, last_accessed, memory_type, tags, created_at))::numeric, 2) AS avg_retention
    FROM tc_memory.knowledge
  `;
  const params: string[] = [];

  if (source) {
    sql += ` WHERE source = $1`;
    params.push(source);
  }

  sql += ` GROUP BY topic ORDER BY MAX(updated_at) DESC`;

  const result = await pool.query(sql, params);
  return result.rows;
}

// Phase 2: Retention scoring — computed on-the-fly via SQL function
async function createRetentionScoreFunction(): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION tc_memory.retention_score(
      p_confidence REAL,
      p_access_count INT,
      p_last_accessed TIMESTAMPTZ,
      p_memory_type TEXT,
      p_tags TEXT[],
      p_created_at TIMESTAMPTZ
    ) RETURNS REAL AS $$
    DECLARE
      decay_rate REAL;
      days_since_access REAL;
      days_since_created REAL;
      importance REAL;
      access_freq REAL;
      recency REAL;
      score REAL;
    BEGIN
      -- Protected tag = always 1.0
      IF p_tags && ARRAY['protected'] THEN RETURN 1.0; END IF;

      -- Core entries never decay
      IF p_memory_type = 'core' THEN RETURN GREATEST(p_confidence, 0.9); END IF;

      -- Decay rates per type
      decay_rate := CASE p_memory_type
        WHEN 'architecture' THEN 0.001
        WHEN 'pattern' THEN 0.005
        WHEN 'decision' THEN 0.01
        ELSE 0.005
      END;

      days_since_access := EXTRACT(EPOCH FROM (NOW() - COALESCE(p_last_accessed, p_created_at))) / 86400.0;
      days_since_created := EXTRACT(EPOCH FROM (NOW() - p_created_at)) / 86400.0;

      -- Importance: confidence with exponential decay
      importance := p_confidence * EXP(-decay_rate * days_since_created);

      -- Access frequency: logarithmic scale (0-1)
      access_freq := LEAST(LN(p_access_count + 1) / LN(50), 1.0);

      -- Recency: linear decay over 180 days
      recency := GREATEST(1.0 - (days_since_access / 180.0), 0.0);

      -- Weighted formula
      score := (importance * 0.4) + (access_freq * 0.3) + (recency * 0.3);
      RETURN GREATEST(LEAST(score, 1.0), 0.0);
    END;
    $$ LANGUAGE plpgsql STABLE
  `);
}

export interface HealthReport {
  total: number;
  by_type: { memory_type: string; count: number }[];
  by_source: { source: string; count: number }[];
  score_distribution: { bucket: string; count: number }[];
  never_accessed: { id: number; topic: string; source: string; created_at: Date }[];
  top_accessed: { id: number; topic: string; access_count: number; memory_type: string }[];
  stale_candidates: { id: number; topic: string; source: string; score: number; memory_type: string }[];
}

export async function getHealthReport(): Promise<HealthReport> {
  const [totalRes, byTypeRes, bySourceRes, scoreRes, neverRes, topRes, staleRes] = await Promise.all([
    pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM tc_memory.knowledge`),
    pool.query<{ memory_type: string; count: number }>(
      `SELECT memory_type, COUNT(*)::int AS count FROM tc_memory.knowledge GROUP BY memory_type ORDER BY count DESC`
    ),
    pool.query<{ source: string; count: number }>(
      `SELECT source, COUNT(*)::int AS count FROM tc_memory.knowledge GROUP BY source ORDER BY count DESC`
    ),
    pool.query<{ bucket: string; count: number }>(`
      WITH scores AS (
        SELECT tc_memory.retention_score(confidence, access_count, last_accessed, memory_type, tags, created_at) AS score
        FROM tc_memory.knowledge
      )
      SELECT
        CASE
          WHEN score >= 0.7 THEN 'healthy'
          WHEN score >= 0.3 THEN 'aging'
          WHEN score >= 0.1 THEN 'stale'
          ELSE 'decay'
        END AS bucket,
        COUNT(*)::int AS count
      FROM scores GROUP BY bucket ORDER BY MIN(score) DESC
    `),
    pool.query<{ id: number; topic: string; source: string; created_at: Date }>(
      `SELECT id, topic, source, created_at FROM tc_memory.knowledge WHERE access_count = 0 ORDER BY created_at ASC LIMIT 10`
    ),
    pool.query<{ id: number; topic: string; access_count: number; memory_type: string }>(
      `SELECT id, topic, access_count, memory_type FROM tc_memory.knowledge ORDER BY access_count DESC LIMIT 10`
    ),
    pool.query<{ id: number; topic: string; source: string; score: number; memory_type: string }>(`
      SELECT * FROM (
        SELECT id, topic, source, memory_type,
          tc_memory.retention_score(confidence, access_count, last_accessed, memory_type, tags, created_at) AS score
        FROM tc_memory.knowledge
        WHERE memory_type != 'core' AND NOT (tags && ARRAY['protected'])
      ) sub WHERE score < 0.3
      ORDER BY score ASC LIMIT 10
    `),
  ]);

  return {
    total: totalRes.rows[0].count,
    by_type: byTypeRes.rows,
    by_source: bySourceRes.rows,
    score_distribution: scoreRes.rows,
    never_accessed: neverRes.rows,
    top_accessed: topRes.rows,
    stale_candidates: staleRes.rows,
  };
}

// Phase 3: Fuzzy duplicate detection via pg_trgm
export interface DuplicatePair {
  id_a: number;
  topic_a: string;
  id_b: number;
  topic_b: string;
  similarity: number;
}

export async function findDuplicates(threshold: number = 0.6): Promise<DuplicatePair[]> {
  const result = await pool.query<DuplicatePair>(
    `SELECT a.id AS id_a, a.topic AS topic_a, b.id AS id_b, b.topic AS topic_b,
            ROUND(similarity(a.topic || ' ' || a.content, b.topic || ' ' || b.content)::numeric, 3) AS similarity
     FROM tc_memory.knowledge a
     JOIN tc_memory.knowledge b ON a.id < b.id
     WHERE similarity(a.topic || ' ' || a.content, b.topic || ' ' || b.content) > $1
     ORDER BY similarity DESC
     LIMIT 50`,
    [threshold]
  );
  return result.rows;
}

// Merge two entries: keep one, combine metadata, delete the other
export async function mergeKnowledge(
  keepId: number,
  deleteId: number,
  mergedContent?: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const [keepRow, deleteRow] = await Promise.all([
      client.query<KnowledgeRow>(`SELECT * FROM tc_memory.knowledge WHERE id = $1`, [keepId]),
      client.query<KnowledgeRow>(`SELECT * FROM tc_memory.knowledge WHERE id = $1`, [deleteId]),
    ]);

    if (keepRow.rows.length === 0 || deleteRow.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    const keep = keepRow.rows[0];
    const del = deleteRow.rows[0];

    // Combine: sum access counts, union tags, take higher confidence
    const combinedTags = [...new Set([...keep.tags, ...del.tags])];
    const combinedAccess = keep.access_count + del.access_count;
    const higherConfidence = Math.max(keep.confidence, del.confidence);
    const content = mergedContent ?? keep.content;

    await client.query(
      `UPDATE tc_memory.knowledge
       SET content = $1, tags = $2, access_count = $3, confidence = $4, updated_at = NOW()
       WHERE id = $5`,
      [content, combinedTags, combinedAccess, higherConfidence, keepId]
    );

    await client.query(`DELETE FROM tc_memory.knowledge WHERE id = $1`, [deleteId]);

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Prune stale entries based on retention score
export interface PruneResult {
  deleted: { id: number; topic: string; source: string; score: number }[];
  flagged: { id: number; topic: string; source: string; score: number }[];
}

export async function pruneStaleEntries(dryRun: boolean = true): Promise<PruneResult> {
  // Find candidates: score < 0.1 for deletion, < 0.3 for flagging
  // Core + protected are always immune
  const candidates = await pool.query<{ id: number; topic: string; source: string; score: number }>(`
    SELECT * FROM (
      SELECT id, topic, source,
        tc_memory.retention_score(confidence, access_count, last_accessed, memory_type, tags, created_at) AS score
      FROM tc_memory.knowledge
      WHERE memory_type != 'core' AND NOT (tags && ARRAY['protected'])
    ) sub WHERE score < 0.3
    ORDER BY score ASC
  `);

  const toDelete = candidates.rows.filter((r) => r.score < 0.1);
  const toFlag = candidates.rows.filter((r) => r.score >= 0.1 && r.score < 0.3);

  if (!dryRun && toDelete.length > 0) {
    const ids = toDelete.map((r) => r.id);
    await pool.query(`DELETE FROM tc_memory.knowledge WHERE id = ANY($1)`, [ids]);
  }

  return {
    deleted: toDelete,
    flagged: toFlag,
  };
}

export async function deleteKnowledge(id: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM tc_memory.knowledge WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export { pool };
