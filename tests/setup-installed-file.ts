// ahood#979: every install now also records itself in the user-level
// ~/.ahood/installed.json. Many suites install into a temp project without
// pointing HOME anywhere, so without this the test run would write into the
// real home directory of whoever runs it. Each worker gets its own temp file;
// a test that wants a specific path sets AHOOD_INSTALLED_FILE itself.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AHOOD_INSTALLED_FILE = join(mkdtempSync(join(tmpdir(), "ahood-installed-")), "installed.json");

// ahood#1018 step B: `ahood setup` asks GitHub whether the `release` branch
// exists before installing from it. No test reaches GitHub: the branch
// "exists" unless a test swaps in another answer (setReleaseProbeForTests).
import { setReleaseProbeForTests } from "../src/setup/release-channel.js";
setReleaseProbeForTests(async () => true);
