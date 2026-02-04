import { z } from "zod";
import { deleteKnowledge } from "../db.js";

export const deleteKnowledgeTool = {
  name: "delete_knowledge",
  config: {
    description: "Delete a specific knowledge entry by ID. Use for cleaning up outdated or incorrect entries.",
    inputSchema: {
      id: z.number().int().positive().describe("The ID of the knowledge entry to delete"),
    },
  },
  handler: async ({ id }: { id: number }) => {
    const deleted = await deleteKnowledge(id);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          message: deleted ? "Deleted" : "Not found",
          id,
        }),
      }],
    };
  },
};
