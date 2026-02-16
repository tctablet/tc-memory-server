import { z } from "zod";
import { mergeKnowledge } from "../db.js";

export const mergeKnowledgeTool = {
  name: "merge_knowledge",
  config: {
    description:
      "Merge two knowledge entries into one. Keeps the first entry, combines access counts and tags from both, takes higher confidence, and deletes the second entry. Optionally provide merged content.",
    inputSchema: {
      keep_id: z.number().int().positive().describe("ID of the entry to keep"),
      delete_id: z.number().int().positive().describe("ID of the entry to delete (merged into keep_id)"),
      merged_content: z.string().max(2000).optional().describe("Optional merged content. If omitted, keeps content from keep_id."),
    },
  },
  handler: async ({ keep_id, delete_id, merged_content }: {
    keep_id: number;
    delete_id: number;
    merged_content?: string;
  }) => {
    const success = await mergeKnowledge(keep_id, delete_id, merged_content);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          message: success ? "Merged successfully" : "One or both entries not found",
          keep_id,
          delete_id,
          success,
        }),
      }],
    };
  },
};
