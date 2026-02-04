import { z } from "zod";
import { listTopics } from "../db.js";

export const listTopicsTool = {
  name: "list_topics",
  config: {
    description:
      "List all knowledge topics in the shared Team Clash memory, grouped with counts and which agents contributed.",
    inputSchema: {
      source: z.string().optional().describe("Filter by agent/project source"),
    },
  },
  handler: async ({ source }: { source?: string }) => {
    const topics = await listTopics(source);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ topics, count: topics.length }) }],
    };
  },
};
