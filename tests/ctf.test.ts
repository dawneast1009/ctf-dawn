import assert from "node:assert/strict";
import test from "node:test";
import { categoryChannelName, isAllSolved, normalizeCtfCategory, parseKstDateTime } from "../src/ctf/core";
import { detectPlatform, parseHspaceChallengePage } from "../src/ctf/platforms";
import { decryptSecret, encryptSecret } from "../src/ctf/secrets";

test("CTF 문제 분야를 소문자 채널명으로 정규화한다", () => {
  assert.equal(normalizeCtfCategory(" Web Exploit "), "web-exploit");
  assert.equal(normalizeCtfCategory("PWN"), "pwn");
  assert.equal(normalizeCtfCategory(""), "misc");
});

test("대회 시각은 한국 시간으로 해석한다", () => {
  assert.equal(parseKstDateTime("2026-08-01 16:00"), Date.UTC(2026, 7, 1, 7, 0));
  assert.equal(parseKstDateTime("2026-02-30 10:00"), null);
});

test("추가된 미해결 문제가 있으면 All Solve를 해제한다", () => {
  assert.equal(isAllSolved([{ solved: true }, { solved: true }] as any), true);
  assert.equal(isAllSolved([{ solved: true }, { solved: false }] as any), false);
  assert.equal(isAllSolved([]), false);
});

test("분야 채널은 전부 풀렸을 때만 파란색이다", () => {
  assert.equal(categoryChannelName("rev", [{ solved: false }]), "⬜｜rev");
  assert.equal(categoryChannelName("rev", [{ solved: true }, { solved: true }]), "🟦｜rev");
  assert.equal(categoryChannelName("rev", []), "⬜｜rev");
});

test("HSPACE FORGE 문제 카드를 DAWN 형식으로 변환한다", async () => {
  assert.equal(await detectPlatform("https://forge.hspace.io/competitions/6905f6cba3e85ec8046e4ff4"), "hspace");
  const html = '<a href="/competitions/6905f6cba3e85ec8046e4ff4/challenges/691234567890abcdef123456"><span>web</span><strong>Travel the World</strong><span>250</span></a>';
  assert.deepEqual(parseHspaceChallengePage(html, "6905f6cba3e85ec8046e4ff4"), [
    { externalId: "691234567890abcdef123456", name: "Travel the World", category: "web" },
  ]);
});

test("대회 Access-Token을 인증 암호화해 복원한다", () => {
  const oldKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const encrypted = encryptSecret("secret-access-token");
    assert.notEqual(encrypted.includes("secret-access-token"), true);
    assert.equal(decryptSecret(encrypted), "secret-access-token");
  } finally {
    if (oldKey == null) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = oldKey;
  }
});
