-- TC Memory Server - Database Schema
-- Run once on the PostgreSQL instance

CREATE SCHEMA IF NOT EXISTS tc_memory;

CREATE TABLE IF NOT EXISTS tc_memory.knowledge (
  id            SERIAL PRIMARY KEY,
  topic         TEXT NOT NULL,
  content       TEXT NOT NULL,
  source        TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  confidence    REAL DEFAULT 1.0,
  search_vector TSVECTOR,
  user_id       TEXT DEFAULT 'unknown',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger to auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION tc_memory.update_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('german', COALESCE(NEW.topic, '')), 'A') ||
    setweight(to_tsvector('german', COALESCE(NEW.content, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(array_to_string(NEW.tags, ' '), '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_knowledge_search_vector'
  ) THEN
    CREATE TRIGGER trg_knowledge_search_vector
      BEFORE INSERT OR UPDATE ON tc_memory.knowledge
      FOR EACH ROW EXECUTE FUNCTION tc_memory.update_search_vector();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_knowledge_search ON tc_memory.knowledge USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON tc_memory.knowledge(source);
CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON tc_memory.knowledge(topic);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON tc_memory.knowledge(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON tc_memory.knowledge USING GIN(tags);
