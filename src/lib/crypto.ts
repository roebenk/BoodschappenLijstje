import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "./config";

const SALT = "boodschappenlijstje-token-v1";

function resolveKey(): Buffer {
  const { tokenEncryptionKey, dataDir } = getRuntimeConfig();
  let secret = tokenEncryptionKey;
  if (!secret) {
    const keyFile = path.join(dataDir, ".token.key");
    if (fs.existsSync(keyFile)) {
      secret = fs.readFileSync(keyFile, "utf8").trim();
    }
    if (!secret) {
      fs.mkdirSync(dataDir, { recursive: true });
      secret = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(keyFile, secret, { mode: 0o600 });
    }
  }
  return crypto.scryptSync(secret, SALT, 32);
}

/** Encrypts a JSON-serialisable payload as `ivHex:tagHex:cipherHex` (AES-256-GCM). */
export function encryptSecrets(payload: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", resolveKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecrets<T>(ciphertext: string): T {
  const [ivHex, tagHex, dataHex] = ciphertext.split(":");
  if (!ivHex || !tagHex || dataHex === undefined) throw new Error("Invalid ciphertext format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", resolveKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as T;
}
