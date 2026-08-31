import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const CLI_NAME = pkg.name;
export const CLI_VERSION = pkg.version;
