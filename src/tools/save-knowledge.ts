import { z } from "zod";
import { saveKnowledge, findNearMatches, updateKnowledge } from "../db.js";
import type { MemoryType } from "../db.js";

const VALID_SOURCES = [
  "website", "godot-pay", "godot-tablet", "godot-mgmt",
  "gas", "devops", "stripe", "infrastructure", "unknown",
];

const VALID_MEMORY_TYPES = ["core", "architecture", "pattern", "decision"] as const;

export const saveKnowledgeTool = {
  name: "save_knowledge",
  config: {
    description:
      "Save knowledge to the shared Team Clash memory. Use this after significant code changes, architecture decisions, or when you learn something that other agents should know. " +
      "By default this runs a server-side duplicate check: if similar entries already exist it returns them WITHOUT saving, so you can consolidate instead of creating a duplicate. " +
      "Then call again with merge_into=<id> to fold your (consolidated) content into that entry, or confirm_new=true to save as a genuinely new entry.",
    inputSchema: {
      topic: z.string().min(1).max(100).describe("Topic category (e.g. 'pricing', 'booking-api', 'stripe-config')"),
      content: z.string().min(1).max(2000).describe("The knowledge to save (max 2000 chars)"),
      source: z.enum(VALID_SOURCES as [string, ...string[]]).describe("Agent/project ID that produced this knowledge"),
      tags: z.array(z.string()).max(10).optional().describe("Optional tags for filtering (e.g. ['breaking-change', 'config'])"),
      confidence: z.number().min(0).max(1).optional().describe("Confidence score 0-1 (default 1.0)"),
      user: z.string().max(50).optional().describe("Developer identifier (e.g. 'cpg', 'gpopp'). Defaults to 'unknown'."),
      memory_type: z.enum(VALID_MEMORY_TYPES).optional().describe("Memory type: core (never decays), architecture (slow decay), pattern (medium decay), decision (fast decay). Auto-classified if omitted."),
      confirm_new: z.boolean().optional().describe("Set true to skip the duplicate check and save as a new entry (use after reviewing near_matches)."),
      merge_into: z.number().int().positive().optional().describe("Instead of saving new, fold this content into the existing entry with this id (consolidate a duplicate)."),
    },
  },
  handler: async ({ topic, content, source, tags, confidence, user, memory_type, confirm_new, merge_into }: {
    topic: string;
    content: string;
    source: string;
    tags?: string[];
    confidence?: number;
    user?: string;
    memory_type?: MemoryType;
    confirm_new?: boolean;
    merge_into?: number;
  }) => {
    const json = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] });

    // Consolidation path: fold the (consolidated) content into an existing entry.
    if (merge_into) {
      const ok = await updateKnowledge(merge_into, content, tags, confidence, user, memory_type);
      return json(ok
        ? { merged: true, id: merge_into, message: `Merged into #${merge_into}`, topic }
        : { merged: false, error: `Entry #${merge_into} not found` });
    }

    // Duplicate-gate: surface near-matches and refuse to silently create a duplicate.
    if (!confirm_new) {
      const near = await findNearMatches(topic, content);
      if (near.length > 0) {
        return json({
          saved: false,
          near_matches: near,
          hint: `Found ${near.length} similar entr${near.length === 1 ? "y" : "ies"}. ` +
            `To consolidate, call save_knowledge again with merge_into=<id> and the merged content. ` +
            `To save anyway as a distinct new entry, call again with confirm_new=true.`,
        });
      }
    }

    const id = await saveKnowledge(topic, content, source, tags ?? [], confidence ?? 1.0, user ?? "unknown", memory_type);
    return json({ saved: true, id, message: "Saved", topic, source, memory_type: memory_type ?? "auto", user: user ?? "unknown" });
  },
};
