import assert from "node:assert/strict";
import test from "node:test";
import { appendRemoteAnnouncement, categoryChannelName, isAllSolved, normalizeCtfCategory, parseKstDateTime, remoteContentChanges, remoteSyncAnnouncement, selectChallengeDetailBatch, splitChallengeDescription } from "../src/ctf/core";
import { assertSafeRemoteUrl, ctfdSessionCookieHeader, detectPlatform, downloadRemoteChallengeFile, fetchChallengesWithSession, fetchChallengesWithToken, fetchCtfdChallengeDetails, fetchCtfdChallengeDetailsBatch, fetchPublicChallenges, parseCtfdSchedulePage, parseHspaceChallengePage } from "../src/ctf/platforms";
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

test("CTFd 문제 설명과 파일 정보를 손실하지 않는다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    data: [{
      id: 7,
      name: "Welcome",
      category: "misc",
      description: "설명 **전체**",
      files: ["/files/abc123/challenge.zip?token=signed"],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const challenges = await fetchPublicChallenges("ctfd", "https://ctf.example.com");
    assert.deepEqual(challenges, [{
      externalId: "7",
      name: "Welcome",
      category: "misc",
      description: "설명 **전체**",
      files: [{ id: "/files/abc123/challenge.zip", name: "challenge.zip", url: "https://ctf.example.com/files/abc123/challenge.zip?token=signed" }],
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("긴 문제 설명을 빠짐없이 Discord 크기로 나눈다", () => {
  const description = `${"가".repeat(4090)}\n${"나".repeat(30)}`;
  const chunks = splitChallengeDescription(description);
  assert.ok(Array.isArray(chunks));
  assert.equal(chunks.join(""), description);
  assert.equal(chunks.every((chunk: string) => chunk.length <= 4096), true);
  const emojiChunks = splitChallengeDescription(`${"a".repeat(4095)}😀`);
  assert.equal(/[\uD800-\uDBFF]$/.test(emojiChunks[0]), false);
  assert.equal(emojiChunks.join(""), `${"a".repeat(4095)}😀`);
});

test("설명과 파일의 추가 교체 삭제를 구분한다", () => {
  const changes = remoteContentChanges(
    {
      description: "이전 설명",
      files: [
        { id: "/files/old/challenge.zip", name: "challenge.zip", url: "https://ctf.example.com/files/old/challenge.zip?token=one" },
        { id: "/files/old/old.txt", name: "old.txt", url: "https://ctf.example.com/files/old/old.txt" },
      ],
    },
    {
      description: "새 설명",
      files: [
        { id: "/files/new/challenge.zip", name: "challenge.zip", url: "https://ctf.example.com/files/new/challenge.zip?token=two" },
        { id: "/files/new/readme.txt", name: "readme.txt", url: "https://ctf.example.com/files/new/readme.txt" },
      ],
    },
  );
  assert.deepEqual(changes, ["문제 설명", "파일 교체: challenge.zip", "파일 추가: readme.txt", "파일 삭제: old.txt"]);
});

test("이름이 같은 여러 파일도 개별 변경으로 추적한다", () => {
  assert.deepEqual(remoteContentChanges(
    { files: [{ id: "a", name: "source.zip", url: "" }, { id: "b", name: "source.zip", url: "" }] },
    { files: [{ id: "a", name: "source.zip", url: "" }] },
  ), ["파일 삭제: source.zip"]);
  assert.deepEqual(remoteContentChanges(
    { files: [{ id: "same-id", name: "old.zip", url: "" }] },
    { files: [{ id: "same-id", name: "new.zip", url: "" }] },
  ), ["파일 이름 변경: old.zip → new.zip"]);
});

test("CTFd 상세 점검은 순환 배치로 모든 문제를 빠짐없이 선택한다", () => {
  assert.deepEqual(selectChallengeDetailBatch(["1", "2", "3"], 2, 2), { ids: ["3", "1"], nextCursor: 1 });
  assert.deepEqual(selectChallengeDetailBatch(["1"], 9, 5), { ids: ["1"], nextCursor: 0 });
});

test("신규 문제와 변경 내역을 general 공지로 만든다", () => {
  assert.equal(remoteSyncAnnouncement("Welcome", "123", "created", []), "🆕 새 문제 **Welcome** · <#123>");
  assert.equal(remoteSyncAnnouncement("Welcome", "123", "updated", ["문제 설명", "파일 추가: source.zip"]), "🔄 문제 업데이트 **Welcome** · 문제 설명, 파일 추가: source.zip · <#123>");
  const bounded = remoteSyncAnnouncement("Welcome", "123", "updated", Array.from({ length: 100 }, (_, index) => `파일 추가: ${"x".repeat(100)}-${index}.zip`));
  assert.equal(bounded.length <= 2000, true);
  assert.match(bounded, /외 \d+건/);
});

test("전송 대기 공지는 중복 없이 보존한다", () => {
  assert.deepEqual(appendRemoteAnnouncement(undefined, "첫 공지"), ["첫 공지"]);
  assert.deepEqual(appendRemoteAnnouncement(["첫 공지"], "둘째 공지"), ["첫 공지", "둘째 공지"]);
  assert.deepEqual(appendRemoteAnnouncement(["첫 공지"], "첫 공지"), ["첫 공지"]);
});

test("CTFd 문제 상세를 인증 상태로 조회한다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  let requestedUrl = "";
  let cookie = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    cookie = new Headers(init?.headers).get("cookie") ?? "";
    return new Response(JSON.stringify({ success: true, data: { id: 9, name: "Detail", category: "web", description: "전문", files: ["/files/hash/source.py"] } }), { status: 200 });
  };
  try {
    const detail = await fetchCtfdChallengeDetails("https://ctf.example.com", "9", { type: "session", value: "cookie-value" });
    assert.equal(requestedUrl, "https://ctf.example.com/api/v1/challenges/9");
    assert.equal(cookie, "session=cookie-value");
    assert.equal(detail.description, "전문");
    assert.equal(detail.files[0].name, "source.py");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("일부 CTFd 상세 조회가 실패해도 나머지 문제는 동기화한다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  globalThis.fetch = async (input) => {
    const id = String(input).split("/").pop();
    if (id === "1") return new Response("error", { status: 500 });
    return new Response(JSON.stringify({ success: true, data: { id: 2, name: "둘", category: "web", description: "상세" } }), { status: 200 });
  };
  try {
    const result = await fetchCtfdChallengeDetailsBatch(
      "https://ctf.example.com",
      [{ externalId: "1", name: "하나", category: "misc" }, { externalId: "2", name: "둘", category: "web" }],
      new Set(["1", "2"]),
    );
    assert.deepEqual(result.challenges, [{ externalId: "1", name: "하나", category: "misc" }, { externalId: "2", name: "둘", category: "web", description: "상세" }]);
    assert.deepEqual(result.failedIds, ["1"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("CTFd 문제 파일은 같은 origin에만 인증을 보내 다운로드한다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } });
  };
  try {
    const result = await downloadRemoteChallengeFile(
      "https://ctf.example.com",
      { id: "/files/hash/challenge.zip", name: "challenge.zip", url: "https://ctf.example.com/files/hash/challenge.zip" },
      { type: "token", value: "api-token" },
    );
    assert.equal(authorization, "Token api-token");
    assert.equal(result.name, "challenge.zip");
    assert.deepEqual([...result.data], [1, 2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("Discord 한도보다 큰 문제 파일은 다운로드 전에 거부한다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  globalThis.fetch = async () => new Response(new Uint8Array(), { status: 200, headers: { "content-length": String(10 * 1024 * 1024 + 1) } });
  try {
    await assert.rejects(
      () => downloadRemoteChallengeFile("https://ctf.example.com", { id: "large", name: "large.zip", url: "https://cdn.example.com/large.zip" }),
      /FILE_TOO_LARGE/,
    );
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

test("시작 전 CTFd도 토큰 인증을 확인하고 빈 문제 목록으로 연결한다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  let contentType = "";
  let tokenVerified = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/v1/challenges")) {
      contentType = new Headers(init?.headers).get("content-type") ?? "";
      return new Response(JSON.stringify({ success: false, message: "JBU CTF 2026 has not started yet" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(input).endsWith("/api/v1/users/me")) {
      tokenVerified = true;
      return new Response(JSON.stringify({ success: true, data: { id: 12, name: "tester" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const result = await fetchChallengesWithToken("https://ctf.example.com", "ctfd_token");
    assert.equal(contentType, "application/json");
    assert.equal(tokenVerified, true);
    assert.deepEqual(result, { platform: "ctfd", challenges: [] });
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("시작 전 CTFd에서 잘못된 토큰은 연결로 저장하지 않는다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/api/v1/challenges")) {
      return new Response(JSON.stringify({ success: false, message: "CTF has not started yet" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false, message: "Your access token is invalid" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await assert.rejects(
      () => fetchChallengesWithToken("https://ctf.example.com", "bad_token"),
      /HTTP_401/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("원격 API 오류 문구를 호출자에게 그대로 노출하지 않는다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  globalThis.fetch = async () => new Response(
    JSON.stringify({ success: false, message: "<@everyone>" }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
  try {
    await assert.rejects(
      () => fetchPublicChallenges("ctfd", "https://ctf.example.com"),
      (error: Error) => error.message === "HTTP_500",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("시작 전 CTFd 자동 감시는 빈 문제 목록으로 대기한다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  globalThis.fetch = async (input) => String(input).endsWith("/api/v1/users/me")
    ? new Response(JSON.stringify({ success: true, data: { id: 12, name: "tester" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    : new Response(JSON.stringify({ success: false, message: "JBU CTF 2026 has not started yet" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  try {
    const challenges = await fetchPublicChallenges("ctfd", "https://ctf.example.com", { type: "token", value: "ctfd_token" });
    assert.deepEqual(challenges, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
  }
});

test("HTTP와 사설 대회 주소를 차단한다", async () => {
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  const oldInsecureHosts = process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "false";
  delete process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS;
  try {
    await assert.rejects(() => assertSafeRemoteUrl("http://ctf.example.com"), /HTTPS/);
    await assert.rejects(() => assertSafeRemoteUrl("https://127.0.0.1:8000"), /사설 네트워크|localhost/);
    await assert.rejects(() => assertSafeRemoteUrl("https://localhost"), /사설 네트워크|localhost/);
  } finally {
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
    if (oldInsecureHosts == null) delete process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS;
    else process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS = oldInsecureHosts;
  }
});

test("명시적으로 허용한 CTFd 호스트에만 HTTP 인증 요청을 보낸다", async () => {
  const originalFetch = globalThis.fetch;
  const oldPrivateHosts = process.env.CTF_ALLOW_PRIVATE_HOSTS;
  const oldInsecureHosts = process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS;
  process.env.CTF_ALLOW_PRIVATE_HOSTS = "true";
  process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS = "jbuctf.kr";
  let requestedUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ success: true, data: [{ id: 1, name: "HTTP Challenge", category: "web", files: ["/files/hash/source.zip"] }] }), { status: 200 });
  };
  try {
    const challenges = await fetchPublicChallenges("ctfd", "http://jbuctf.kr", { type: "token", value: "api-token" });
    assert.equal(requestedUrl, "http://jbuctf.kr/api/v1/challenges");
    assert.equal(authorization, "Token api-token");
    assert.equal(challenges[0].files?.[0].url, "http://jbuctf.kr/files/hash/source.zip");
    await assert.rejects(() => fetchPublicChallenges("ctfd", "http://other.example.com", { type: "token", value: "api-token" }), /HTTPS/);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPrivateHosts == null) delete process.env.CTF_ALLOW_PRIVATE_HOSTS;
    else process.env.CTF_ALLOW_PRIVATE_HOSTS = oldPrivateHosts;
    if (oldInsecureHosts == null) delete process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS;
    else process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS = oldInsecureHosts;
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
