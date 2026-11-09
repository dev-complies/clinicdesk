/**
 * evals/stub-server-only.ts
 *
 * Standalone CLI scripts (like the eval runner) are not bundled by Next.js, so the
 * "server-only" marker package throws when imported from plain Node. This file makes
 * require("server-only") resolve to an empty module. Import it FIRST, before any
 * module that (transitively) imports "server-only".
 */
import Module from "module";

const proto = Module.prototype as unknown as {
  require: (this: unknown, id: string) => unknown;
};
const originalRequire = proto.require;
proto.require = function (this: unknown, id: string) {
  if (id === "server-only") return {};
  return originalRequire.call(this, id);
};
