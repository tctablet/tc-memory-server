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
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('german', topic), 'A') ||
    setweight(to_tsvector('german', content), 'B') ||
    setweight(to_tsvector('simple', array_to_string(tags, ' ')), 'C')
  ) STORED,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_search ON tc_memory.knowledge USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON tc_memory.knowledge(source);
CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON tc_memory.knowledge(topic);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON tc_memory.knowledge(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON tc_memory.knowledge USING GIN(tags);
