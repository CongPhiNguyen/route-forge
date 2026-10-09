import { refuseLaneP } from "./lane-p.ts";
import { runLaneF } from "./lane-f.ts";

const command = process.argv[2];

if (command === "dry-run") {
  const result = await runLaneF({ dryRun: true });
  process.exit(result.exitCode);
}

if (command === "lane-f") {
  const result = await runLaneF({ dryRun: false });
  process.exit(result.exitCode);
}

if (command === "lane-p") {
  try {
    refuseLaneP();
    process.stderr.write("Lane P guard returned without a denial\n");
    process.exit(2);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
}

process.stderr.write("Usage: cli.ts <dry-run|lane-f|lane-p>\n");
process.exit(2);
