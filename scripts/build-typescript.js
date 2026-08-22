import path from "node:path";
import { buildTypescript, repositoryRoot } from "./typescript-lane.js";

const args = process.argv.slice(2);
let outputDirectory = path.join(repositoryRoot, "dist");
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== "--out-dir") {
    throw new TypeError("build-typescript accepts only --out-dir path");
  }
  outputDirectory = path.resolve(args[1]);
}

await buildTypescript({ outputDirectory });
process.stdout.write(`built TypeScript artifact at ${outputDirectory}\n`);
