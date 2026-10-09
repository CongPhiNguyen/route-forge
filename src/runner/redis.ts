import net from "node:net";

export function encodeRedis(parts: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const body = Buffer.from(part);
    chunks.push(Buffer.from(`$${body.length}\r\n`));
    chunks.push(body);
    chunks.push(Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

export function flushRedisDb(host: string, port: number, db: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const payload = Buffer.concat([encodeRedis(["SELECT", String(db)]), encodeRedis(["FLUSHDB"])]);
    let response = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve();
    };
    socket.setTimeout(5000, () => fail(new Error(`Redis flush timed out at ${host}:${port}`)));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("-ERR")) {
        fail(new Error(`Redis flush failed: ${response.trim()}`));
        return;
      }
      if (response.split("+OK").length >= 3) succeed();
    });
    socket.write(payload);
  });
}
