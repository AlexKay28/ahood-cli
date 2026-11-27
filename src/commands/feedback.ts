// `ahood feedback` (ahood#1673): send product feedback to the ahood team via
// POST /api/v1/feedback. Auth is optional on the server: logged out it is an
// anonymous message (rate limited harder), logged in it is attributed and a
// token needs the 'publish' scope. Only the vocabulary and the length cap are
// mirrored from the server (lib/feedback.ts); the secret scan and control
// character checks are the server's call and its answer is explained here.
import { ApiError, apiJson } from "../http.js";
import { flagValue, unrecognizedArgs } from "../flags.js";
import { sanitizeForTerminal } from "../terminal-safe.js";
import { UsageError } from "../usage-error.js";
import { CLI_VERSION } from "../version.js";

const USAGE = 'Usage: ahood feedback "<message>" [--kind bug|idea|search_miss|confusing|praise] [--query <q>] [--artifact <owner/slug>]';

export const FEEDBACK_KINDS = ["bug", "idea", "search_miss", "confusing", "praise"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
const DEFAULT_KIND: FeedbackKind = "idea";
/** ahood lib/feedback.ts MAX_FEEDBACK_MESSAGE_LENGTH. */
export const MAX_FEEDBACK_MESSAGE_LENGTH = 4000;

export async function feedback(args: string[]): Promise<void> {
  const leftover = unrecognizedArgs(args, [], ["--kind", "--query", "--artifact"]);
  const flagLike = leftover.find((a) => a.startsWith("--"));
  if (flagLike) throw new UsageError(`Unknown argument: ${flagLike}\n${USAGE}`);
  const message = leftover.join(" ").trim();
  if (!message) throw new UsageError(`A feedback message is required.\n${USAGE}`);
  if (message.length > MAX_FEEDBACK_MESSAGE_LENGTH) {
    throw new UsageError(`Feedback is ${message.length} characters; the limit is ${MAX_FEEDBACK_MESSAGE_LENGTH}.`);
  }
  const kind = (flagValue(args, "--kind") ?? DEFAULT_KIND) as FeedbackKind;
  if (!FEEDBACK_KINDS.includes(kind)) throw new UsageError(`--kind must be one of: ${FEEDBACK_KINDS.join(", ")}.\n${USAGE}`);
  const query = flagValue(args, "--query");
  const artifact = flagValue(args, "--artifact");

  const context: Record<string, string> = { surface: "cli", cli_version: CLI_VERSION };
  if (query) context.query = query;
  if (artifact) context.artifact = artifact;

  try {
    await apiJson<{ id: string }>("/api/v1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ahood-Source": "cli" },
      body: JSON.stringify({ kind, message, context }),
    });
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError(error.status, explain(error), error.body);
    throw error;
  }
  console.log(`Thanks, your ${kind.replace("_", " ")} feedback was sent to the ahood team.`);
}

function explain(error: ApiError): string {
  const server = sanitizeForTerminal(error.message);
  switch (error.status) {
    case 400:
      return /secret|token/i.test(error.message)
        ? "Feedback was rejected because it looks like it contains a secret or token. Remove it and send again."
        : `Feedback was rejected: ${server}`;
    case 403:
      return "Your token cannot send feedback: it needs the 'publish' scope. Send it logged out, or run `ahood login`.";
    case 415:
      return "The server refused the request format (expected JSON). Update the CLI: `npx @ahood/cli@latest`.";
    case 429:
      return "Too much feedback for now. Try again later.";
    default:
      return server;
  }
}
