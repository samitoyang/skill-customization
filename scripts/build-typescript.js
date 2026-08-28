import path from "node:path";
import {
  buildPublicationArtifact,
  buildTypescript,
  repositoryRoot,
} from "./typescript-lane.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  const outputDirectory = path.join(repositoryRoot, "dist");
  await buildTypescript({ outputDirectory });
  process.stdout.write(`built TypeScript output at ${outputDirectory}\n`);
} else if (args.length === 2 && args[0] === "--out-dir") {
  const outputDirectory = path.resolve(args[1]);
  await buildTypescript({ outputDirectory });
  process.stdout.write(`built TypeScript output at ${outputDirectory}\n`);
} else if (args.length === 2 && args[0] === "--publication-out-dir") {
  const outputDirectory = path.resolve(args[1]);
  await buildPublicationArtifact({ outputDirectory });
  process.stdout.write(`built publication artifact at ${outputDirectory}\n`);
} else {
  throw new TypeError(
    "build-typescript accepts only --out-dir path or --publication-out-dir path",
  );
}
