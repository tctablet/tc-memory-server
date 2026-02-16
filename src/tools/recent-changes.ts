import { z } from "zod";
import { getRecentChanges } from "../db.js";

export const recentChangesTool = {
  name: "get_recent_changes",
  config: {
    description:
      "Get recent knowledge entries from the shared Team Clash memory. Use at session start or before working on cross-cutting concerns.",
    inputSchema: {
      hours: z.number().min(1).max(720).optional().describe("Look back N hours (default 48)"),
      source: z.string().optional().describe("Filter by agent/project source"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
    },
  },
  handler: async ({ hours, source, limit }: {
    hours?: number;
    source?: string;
    limit?: number;
  }) => {
    const changes = await getRecentChanges(hours ?? 48, source, limit ?? 20);
    const formatted = changes.map((r) => ({
      id: r.id,
      topic: r.topic,
      content: r.content,
      source: r.source,
      user: r.user_id,
      tags: r.tags,
      memory_type: r.memory_type,
      access_count: r.access_count,
      created_at: r.created_at,
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ changes: formatted, count: formatted.length }) }],
    };
  },
};
