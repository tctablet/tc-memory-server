import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initDb, saveKnowledge, getRecentChanges, searchKnowledge, getHealthReport, pruneStaleEntries } from "./db.js";
import { authMiddleware } from "./auth.js";
import { saveKnowledgeTool } from "./tools/save-knowledge.js";
import { searchKnowledgeTool } from "./tools/search-knowledge.js";
import { recentChangesTool } from "./tools/recent-changes.js";
import { listTopicsTool } from "./tools/list-topics.js";
import { deleteKnowledgeTool } from "./tools/delete-knowledge.js";
import { memoryHealthTool } from "./tools/memory-health.js";
import { findDuplicatesTool } from "./tools/find-duplicates.js";
import { mergeKnowledgeTool } from "./tools/merge-knowledge.js";

const PORT = parseInt(process.env.PORT || "3333", 10);

console.log("[startup] TC Memory Server starting...");
console.log("[startup] NODE_VERSION:", process.version);
console.log("[startup] PORT:", PORT);
console.log("[startup] DATABASE_URL:", process.env.DATABASE_URL ? "set (host: " + (process.env.DATABASE_URL.match(/@([^:]+):/)?.[1] ?? "unknown") + ")" : "NOT SET");
console.log("[startup] TC_MEMORY_TOKEN:", process.env.TC_MEMORY_TOKEN ? "set" : "NOT SET");

async function initDbWithRetry(maxRetries = 5, delayMs = 3000): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[db] Connection attempt ${attempt}/${maxRetries}...`);
      await initDb();
      console.log("[db] Database initialized successfully");
      return;
    } catch (err) {
      console.error(`[db] Attempt ${attempt} failed:`, err instanceof Error ? err.message : err);
      if (attempt < maxRetries) {
        console.log(`[db] Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

async function main() {
  // Create Express app first so health check works even if DB is down
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);

  let dbReady = false;

  // Health check (no auth required - handled in authMiddleware)
  app.get("/health", (_req, res) => {
    res.json({ status: dbReady ? "ok" : "starting", server: "tc-memory", version: "1.0.1", db: dbReady });
  });

  // Start HTTP server immediately so container stays alive
  const server = app.listen(PORT, () => {
    console.log(`[startup] HTTP server listening on port ${PORT}`);
  });

  // Initialize database with retries
  try {
    await initDbWithRetry();
    dbReady = true;
  } catch (err) {
    console.error("[startup] Database initialization failed after all retries:", err);
    console.error("[startup] Server will stay up but DB-dependent routes will fail");
  }

  // Create MCP Server
  console.log("[startup] Registering MCP tools...");
  const mcpServer = new McpServer({
    name: "tc-memory",
    version: "1.0.0",
  });

  // Register all tools
  const tools = [saveKnowledgeTool, searchKnowledgeTool, recentChangesTool, listTopicsTool, deleteKnowledgeTool, memoryHealthTool, findDuplicatesTool, mergeKnowledgeTool];
  for (const tool of tools) {
    mcpServer.tool(tool.name, tool.config.description, tool.config.inputSchema, tool.handler);
  }
  console.log(`[startup] ${tools.length} MCP tools registered`);

  // MCP Streamable HTTP endpoint
  app.all("/mcp", async (req, res) => {
    if (!dbReady) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Simple REST API for hooks (curl-based access)
  app.get("/api/recent", async (req, res) => {
    try {
      const hours = parseInt(req.query.hours as string) || 48;
      const source = req.query.source as string | undefined;
      const limit = parseInt(req.query.limit as string) || 20;
      const changes = await getRecentChanges(hours, source, limit);
      const text = changes
        .map((c) => {
          const time = new Date(c.created_at).toISOString().slice(0, 16).replace("T", " ");
          const user = c.user_id && c.user_id !== "unknown" ? `${c.user_id}:` : "";
          // Truncate content to first 120 chars for compact hook output
          const short = c.content.length > 120 ? c.content.slice(0, 117) + "..." : c.content;
          return `[${time}] ${user}${c.source} | ${c.topic}: ${short}`;
        })
        .join("\n");
      res.type("text/plain").send(text || "No recent changes");
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch recent changes" });
    }
  });

  app.get("/api/search", async (req, res) => {
    try {
      const query = req.query.query as string;
      if (!query) {
        res.status(400).json({ error: "Missing required parameter: query" });
        return;
      }
      const source = req.query.source as string | undefined;
      const limit = parseInt(req.query.limit as string) || 10;
      const tagsParam = req.query.tags as string | undefined;
      const tags = tagsParam ? tagsParam.split(",") : undefined;
      const results = await searchKnowledge(query, source, tags, limit);
      const text = results
        .map((r) => {
          const time = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
          const user = r.user_id && r.user_id !== "unknown" ? `${r.user_id}:` : "";
          const short = r.content.length > 200 ? r.content.slice(0, 197) + "..." : r.content;
          return `[${time}] ${user}${r.source} | ${r.topic}: ${short}`;
        })
        .join("\n");
      res.type("text/plain").send(text || "No results");
    } catch (err) {
      res.status(500).json({ error: "Search failed" });
    }
  });

  app.post("/api/save", async (req, res) => {
    try {
      const { topic, content, source, tags, confidence, user, memory_type } = req.body;
      if (!topic || !content || !source) {
        res.status(400).json({ error: "Missing required fields: topic, content, source" });
        return;
      }
      const id = await saveKnowledge(topic, content, source, tags ?? [], confidence ?? 1.0, user ?? "unknown", memory_type);
      res.json({ id, message: "Saved" });
    } catch (err) {
      res.status(500).json({ error: "Failed to save knowledge" });
    }
  });

  // Phase 2: Health report endpoint
  app.get("/api/health-report", async (_req, res) => {
    try {
      const report = await getHealthReport();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: "Failed to generate health report" });
    }
  });

  // Phase 3: Prune stale entries endpoint
  app.post("/api/prune", async (req, res) => {
    try {
      const dryRun = req.query.dry_run !== "false";
      const result = await pruneStaleEntries(dryRun);
      res.json({ dry_run: dryRun, ...result });
    } catch (err) {
      res.status(500).json({ error: "Prune operation failed" });
    }
  });

  console.log("[startup] All routes registered");
  console.log(`[startup] MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`[startup] REST API: http://localhost:${PORT}/api/recent, /api/search`);
  console.log(`[startup] Health: http://localhost:${PORT}/health`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
