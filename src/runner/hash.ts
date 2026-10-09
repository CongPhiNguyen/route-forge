import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256Buffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text: string): string {
  return sha256Buffer(Buffer.from(text, "utf8"));
}

export function sha256File(file: string): string {
  return sha256Buffer(readFileSync(file));
}
