import { z } from "zod";
import { searchKnowledge } from "../db.js";

export const searchKnowledgeTool = {
  name: "search_knowledge",
  config: {
    description:
      "Search the shared Team Clash memory using full-text search. Use this to find relevant knowledge from other agents/projects before making changes.",
    inputSchema: {
      query: z.string().min(1).describe("Search query (German or English)"),
      source: z.string().optional().describe("Filter by agent/project source (e.g. 'website', 'godot-pay')"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
    },
  },
  handler: async ({ query, source, tags, limit }: {
    query: string;
    source?: string;
    tags?: string[];
    limit?: number;
  }) => {
    const results = await searchKnowledge(query, source, tags, limit ?? 10);
    const formatted = results.map((r) => ({
      id: r.id,
      topic: r.topic,
      content: r.content,
      source: r.source,
      user: r.user_id,
      tags: r.tags,
      confidence: r.confidence,
      created_at: r.created_at,
      rank: r.rank,
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ results: formatted, count: formatted.length }) }],
    };
  },
};
