import assert from "node:assert/strict";
import test from "node:test";
import { categoryChannelName, isAllSolved, normalizeCtfCategory, parseKstDateTime } from "../src/ctf/core";
import { assertSafeRemoteUrl, ctfdSessionCookieHeader, detectPlatform, fetchChallengesWithSession, fetchChallengesWithToken, fetchPublicChallenges, parseCtfdSchedulePage, parseHspaceChallengePage } from "../src/ctf/platforms";
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

test("CTFd session 쿠키값을 안전한 Cookie 헤더로 만든다", () => {
  assert.equal(ctfdSessionCookieHeader("abc.def"), "session=abc.def");
  assert.equal(ctfdSessionCookieHeader("session=abc.def"), "session=abc.def");
  assert.equal(ctfdSessionCookieHeader("theme=dark; session=abc.def; lang=ko"), "session=abc.def");
  assert.throws(() => ctfdSessionCookieHeader("abc\r\nX-Test: value"));
});

test("CTFd 페이지의 대회 일정을 자동으로 읽는다", () => {
  const html = `<style>.thing { start: 1; end: 2; }</style><script>window.init = {
    'start': "2026-08-24T09:00:00+09:00",
    'end': 1787557200,
  }</script>`;
  assert.deepEqual(parseCtfdSchedulePage(html), {
    startsAt: Date.parse("2026-08-24T09:00:00+09:00"),
    endsAt: 1_787_557_200_000,
  });
  assert.equal(parseCtfdSchedulePage(`<script>window.init = {'start': null, 'end': null}</script>`), undefined);
  assert.equal(parseCtfdSchedulePage(`<script>window.init = {'start': 20, 'end': 10}</script>`), undefined);
});

test("CTFd session 쿠키 인증으로 문제를 가져온다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  let cookie = "";
  globalThis.fetch = async (_input, init) => {
    cookie = new Headers(init?.headers).get("cookie") ?? "";
    return new Response(JSON.stringify({ success: true, data: [{ id: 7, name: "Welcome", category: "misc" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await fetchChallengesWithSession("https://ctf.example.com/", "session-cookie-value");
    assert.equal(cookie, "session=session-cookie-value");
    assert.deepEqual(result, { platform: "ctfd", challenges: [{ externalId: "7", name: "Welcome", category: "misc" }] });
    cookie = "";
    const monitored = await fetchPublicChallenges("ctfd", "https://ctf.example.com", { type: "session", value: "session-cookie-value" });
    assert.equal(cookie, "session=session-cookie-value");
    assert.equal(monitored.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("기존 CTFd API 토큰 인증을 유지한다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ success: true, data: [{ id: 8, name: "Token Challenge", category: "web" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await fetchChallengesWithToken("https://ctf.example.com", "api-token");
    assert.equal(authorization, "Token api-token");
    assert.equal(result.platform, "ctfd");
    assert.equal(result.challenges.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("HTTP와 사설 대회 주소를 차단한다", async () => {
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "false";
  try {
    await assert.rejects(() => assertSafeRemoteUrl("http://ctf.example.com"), /HTTPS/);
    await assert.rejects(() => assertSafeRemoteUrl("https://127.0.0.1:8000"), /사설 네트워크|localhost/);
    await assert.rejects(() => assertSafeRemoteUrl("https://localhost"), /사설 네트워크|localhost/);
  } finally {
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
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
