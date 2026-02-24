import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be set to 64 hex chars (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptToken(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptToken(value) {
  if (!value) return value;
  const parts = value.split(":");
  if (parts.length !== 3) return value; // plaintext — not yet encrypted
  const [ivHex, authTagHex, encHex] = parts;
  try {
    const key = getKey();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const encrypted = Buffer.from(encHex, "hex");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return value;
  }
}

export function decryptUserTokens(user) {
  if (!user) return user;
  if (user.fbLongLivedToken) user.fbLongLivedToken = decryptToken(user.fbLongLivedToken);
  if (user.fbPageAccessToken) user.fbPageAccessToken = decryptToken(user.fbPageAccessToken);
  return user;
}
