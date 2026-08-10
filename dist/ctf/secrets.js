"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptSecret = encryptSecret;
exports.decryptSecret = decryptSecret;
const node_crypto_1 = require("node:crypto");
function encryptionKey() {
    const encoded = process.env.TOKEN_ENCRYPTION_KEY?.trim();
    if (!encoded)
        throw new Error("TOKEN_ENCRYPTION_KEY 환경변수가 필요합니다.");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32)
        throw new Error("TOKEN_ENCRYPTION_KEY는 32바이트 Base64 값이어야 합니다.");
    return key;
}
function encryptSecret(value) {
    const iv = (0, node_crypto_1.randomBytes)(12);
    const cipher = (0, node_crypto_1.createCipheriv)("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function decryptSecret(value) {
    const [version, iv, tag, encrypted] = value.split(".");
    if (version !== "v1" || !iv || !tag || !encrypted)
        throw new Error("저장된 토큰 형식이 올바르지 않습니다.");
    const decipher = (0, node_crypto_1.createDecipheriv)("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
