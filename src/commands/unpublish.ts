import { createInterface } from "node:readline/promises";
import { apiJson } from "../http.js";

// Confirmation is required and has no --yes/--force bypass -- this deletes
// the skill for every consumer who has ever `ahood add`ed it, not just the
// local install (that's `ahood remove`). If a non-interactive/CI use case
// shows up later, add an explicit --yes flag then; defaulting to one now
// would make the destructive path the easy one.
async function confirm(promptText: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(promptText);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export async function unpublish(args: string[]): Promise<void> {
  const spec = args[0];
  if (!spec) throw new Error("Usage: ahood unpublish <owner>/<skill>");
  const [owner, skill] = spec.split("/");
  if (!owner || !skill) throw new Error("Usage: ahood unpublish <owner>/<skill>");

  const confirmed = await confirm(
    `This will permanently delete ${owner}/${skill} for everyone who has installed it. Type "yes" to confirm: `,
  );
  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  await apiJson(`/api/v1/skills/${owner}/${skill}`, { method: "DELETE" });
  console.log(`Unpublished ${owner}/${skill}. Run \`ahood remove ${owner}/${skill}\` to also remove your local copy.`);
}
