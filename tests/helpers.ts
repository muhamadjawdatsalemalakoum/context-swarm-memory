import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlStorage } from "../src/storage/jsonlStorage.js";

export async function makeTempStorage(): Promise<{ storage: JsonlStorage; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "csm-test-"));
  const storage = new JsonlStorage(root);
  await storage.ensureLayout();
  return {
    storage,
    root,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function readBytes(path: string): Promise<Buffer> {
  return fs.readFile(path);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      try {
        resolve(serverPort(server));
      } catch (err) {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", onListening);
  });
}

export function serverPort(server: Server): number {
  const address = server.address() as AddressInfo | string | null;
  if (!address || typeof address === "string") {
    throw new Error("HTTP test server did not bind to a TCP port");
  }
  return address.port;
}

export async function waitForServer(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
