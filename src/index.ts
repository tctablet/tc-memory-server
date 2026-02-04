import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initDb, saveKnowledge, getRecentChanges } from "./db.js";
import { authMiddleware } from "./auth.js";
import { saveKnowledgeTool } from "./tools/save-knowledge.js";
import { searchKnowledgeTool } from "./tools/search-knowledge.js";
import { recentChangesTool } from "./tools/recent-changes.js";
import { listTopicsTool } from "./tools/list-topics.js";
import { deleteKnowledgeTool } from "./tools/delete-knowledge.js";

const PORT = parseInt(process.env.PORT || "3333", 10);

async function main() {
  // Initialize database
  await initDb();
  console.log("Database initialized");

  // Create MCP Server
  const mcpServer = new McpServer({
    name: "tc-memory",
    version: "1.0.0",
  });

  // Register all tools
  const tools = [saveKnowledgeTool, searchKnowledgeTool, recentChangesTool, listTopicsTool, deleteKnowledgeTool];
  for (const tool of tools) {
    mcpServer.tool(tool.name, tool.config.description, tool.config.inputSchema, tool.handler);
  }

  // Create Express app
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);

  // Health check (no auth required - handled in authMiddleware)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "tc-memory", version: "1.0.0" });
  });

  // MCP Streamable HTTP endpoint
  // Each request gets its own transport for stateless operation
  app.all("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  // Simple REST API for hooks (curl-based access)
  app.get("/api/recent", async (req, res) => {
    try {
      const hours = parseInt(req.query.hours as string) || 48;
      const source = req.query.source as string | undefined;
      const changes = await getRecentChanges(hours, source);
      const text = changes
        .map((c) => `[${c.source}] ${c.topic}: ${c.content}`)
        .join("\n");
      res.type("text/plain").send(text || "No recent changes");
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch recent changes" });
    }
  });

  app.post("/api/save", async (req, res) => {
    try {
      const { topic, content, source, tags, confidence } = req.body;
      if (!topic || !content || !source) {
        res.status(400).json({ error: "Missing required fields: topic, content, source" });
        return;
      }
      const id = await saveKnowledge(topic, content, source, tags ?? [], confidence ?? 1.0);
      res.json({ id, message: "Saved" });
    } catch (err) {
      res.status(500).json({ error: "Failed to save knowledge" });
    }
  });

  app.listen(PORT, () => {
    console.log(`TC Memory Server running on port ${PORT}`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`REST API: http://localhost:${PORT}/api/recent`);
    console.log(`Health: http://localhost:${PORT}/health`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
