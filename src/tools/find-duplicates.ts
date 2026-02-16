import { z } from "zod";
import { findDuplicates } from "../db.js";

export const findDuplicatesTool = {
  name: "find_duplicates",
  config: {
    description:
      "Find duplicate or near-duplicate entries in the Team Clash memory using fuzzy text similarity. Returns pairs with similarity scores. Use this to identify consolidation candidates.",
    inputSchema: {
      threshold: z.number().min(0.3).max(0.95).optional().describe("Similarity threshold 0.3-0.95 (default 0.6). Lower = more results."),
    },
  },
  handler: async ({ threshold }: { threshold?: number }) => {
    const pairs = await findDuplicates(threshold ?? 0.6);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ pairs, count: pairs.length }) }],
    };
  },
};
