import { z } from "zod";
import { saveKnowledge } from "../db.js";

const VALID_SOURCES = [
  "website", "godot-pay", "godot-tablet", "godot-mgmt",
  "gas", "devops", "stripe", "unknown",
];

export const saveKnowledgeTool = {
  name: "save_knowledge",
  config: {
    description:
      "Save knowledge to the shared Team Clash memory. Use this after significant code changes, architecture decisions, or when you learn something that other agents should know.",
    inputSchema: {
      topic: z.string().min(1).max(100).describe("Topic category (e.g. 'pricing', 'booking-api', 'stripe-config')"),
      content: z.string().min(1).max(2000).describe("The knowledge to save (max 2000 chars)"),
      source: z.enum(VALID_SOURCES as [string, ...string[]]).describe("Agent/project ID that produced this knowledge"),
      tags: z.array(z.string()).max(10).optional().describe("Optional tags for filtering (e.g. ['breaking-change', 'config'])"),
      confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1 (default 1.0)"),
    },
  },
  handler: async ({ topic, content, source, tags, confidence }: {
    topic: string;
    content: string;
    source: string;
    tags?: string[];
    confidence?: number;
  }) => {
    const id = await saveKnowledge(topic, content, source, tags ?? [], confidence ?? 1.0);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ id, message: "Saved", topic, source }) }],
    };
  },
};
