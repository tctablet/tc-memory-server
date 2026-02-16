import { getHealthReport } from "../db.js";

export const memoryHealthTool = {
  name: "memory_health",
  config: {
    description:
      "Get a health report of the Team Clash memory system. Shows score distribution, stale candidates, top-accessed entries, and type/source breakdown. Use this to monitor memory quality.",
    inputSchema: {},
  },
  handler: async () => {
    const report = await getHealthReport();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(report) }],
    };
  },
};
