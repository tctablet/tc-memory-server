import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const SEARCH_VECTOR_EXPR = `
  setweight(to_tsvector('german', COALESCE(topic, '')), 'A') ||
  setweight(to_tsvector('german', COALESCE(content, '')), 'B') ||
  setweight(to_tsvector('simple', COALESCE(array_to_string(tags, ' '), '')), 'C')
`;

// Initialize schema and table
export async function initDb(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS tc_memory`);
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
}

export interface KnowledgeRow {
  id: number;
  topic: string;
  content: string;
  source: string;
  user_id: string;
  tags: string[];
  confidence: number;
  created_at: Date;
  updated_at: Date;
  rank?: number;
}

export async function saveKnowledge(
  topic: string,
  content: string,
  source: string,
  tags: string[],
  confidence: number,
  userId: string = "unknown"
): Promise<number> {
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
       SET content = $1, tags = $2, confidence = $3, user_id = $4, updated_at = NOW()
       WHERE id = $5`,
      [content, tags, confidence, userId, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }

  const result = await pool.query<{ id: number }>(
    `INSERT INTO tc_memory.knowledge (topic, content, source, tags, confidence, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [topic, content, source, tags, confidence, userId]
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
): Promise<{ topic: string; count: number; last_updated: Date; sources: string[] }[]> {
  let sql = `
    SELECT topic,
           COUNT(*)::int AS count,
           MAX(updated_at) AS last_updated,
           array_agg(DISTINCT source) AS sources
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

export async function deleteKnowledge(id: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM tc_memory.knowledge WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export { pool };
