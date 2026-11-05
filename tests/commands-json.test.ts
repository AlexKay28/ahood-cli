import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as help from "../src/help.js";
import { COMMANDS_JSON_PATH, GROUPS, renderCommandsJson } from "../scripts/emit-commands-json.mjs";

// AlexKay28/ahood#995: commands.json feeds the website's /docs command list,
// so a help.ts change that isn't regenerated must fail here, not drift there.
describe("commands.json", () => {
  const committed = readFileSync(COMMANDS_JSON_PATH, "utf8");

  it("matches what src/help.ts's COMMANDS_HELP generates (run `npm run emit-commands`)", () => {
    expect(committed).toBe(renderCommandsJson(help));
  });

  it("has non-empty groups whose entries all carry usage/summary/desc strings", () => {
    const doc = JSON.parse(committed) as { groups: { id: string; commands: Record<string, unknown>[] }[] };
    expect(doc.groups.length).toBeGreaterThan(0);
    for (const group of doc.groups) {
      expect(group.commands.length, group.id).toBeGreaterThan(0);
      for (const entry of group.commands) {
        for (const field of ["usage", "summary", "desc"]) {
          expect(typeof entry[field], `${group.id}: ${String(entry.usage)} .${field}`).toBe("string");
          expect((entry[field] as string).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("covers every exported *_COMMANDS_HELP array, so a new noun can't be left out", () => {
    const exported = Object.keys(help).filter((name) => name.endsWith("_COMMANDS_HELP"));
    expect(GROUPS.map(([, exportName]) => exportName).sort()).toEqual(exported.sort());
  });

  it("surfaces aliases from COMMAND_ALIASES (skill view|show)", () => {
    const doc = JSON.parse(committed) as { groups: { id: string; commands: { usage: string; aliases?: string[] }[] }[] };
    const skill = doc.groups.find((g) => g.id === "skill");
    const view = skill?.commands.find((c) => c.usage.startsWith("ahood skill view "));
    expect(view?.aliases).toEqual(["show"]);
  });
});
