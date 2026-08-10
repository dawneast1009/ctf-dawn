"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectPlatform = detectPlatform;
exports.fetchPublicChallenges = fetchPublicChallenges;
exports.fetchChallengesWithToken = fetchChallengesWithToken;
exports.fetchPublicScoreboard = fetchPublicScoreboard;
const USER_AGENT = "discord-ctf-bot/1.0 (read-only monitor)";
async function safeJson(url, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
        const response = await fetch(url, {
            ...init,
            headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers ?? {}) },
            signal: controller.signal,
        });
        if (response.status === 429)
            throw new Error("RATE_LIMITED");
        if (!response.ok)
            throw new Error(`HTTP_${response.status}`);
        return await response.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
function baseUrl(input) {
    return input.trim().replace(/\/+$/, "");
}
async function detectPlatform(url) {
    const base = baseUrl(url);
    try {
        const json = await safeJson(`${base}/api/v1/challenges`);
        if (json?.success && Array.isArray(json.data))
            return "ctfd";
    }
    catch { /* 다음 형식 확인 */ }
    try {
        const json = await safeJson(`${base}/api/v2/challs`);
        if (Array.isArray(json?.data))
            return "rctf";
    }
    catch { /* 알 수 없는 플랫폼 */ }
    return "generic";
}
/** 인증이 필요 없는 읽기 전용 문제 목록. 로그인 요청이나 플래그 제출은 하지 않는다. */
async function fetchPublicChallenges(platform, url) {
    const base = baseUrl(url);
    if (platform === "ctfd") {
        const json = await safeJson(`${base}/api/v1/challenges`);
        if (!json?.success || !Array.isArray(json.data))
            throw new Error("CTFd 문제 목록 형식이 아닙니다.");
        return json.data.map((item) => ({
            externalId: String(item.id),
            name: String(item.name ?? "").trim(),
            category: String(item.category ?? "misc").trim(),
        })).filter((item) => item.name);
    }
    if (platform === "rctf") {
        const json = await safeJson(`${base}/api/v2/challs`);
        if (!Array.isArray(json?.data))
            throw new Error("rCTF 문제 목록 형식이 아닙니다.");
        return json.data.map((item) => ({
            externalId: String(item.id),
            name: String(item.name ?? "").trim(),
            category: String(item.category ?? "misc").trim(),
        })).filter((item) => item.name);
    }
    throw new Error("이 플랫폼은 공개 문제 API 자동 감시를 지원하지 않습니다.");
}
/** 한 번 입력한 읽기 토큰으로만 조회한다. 토큰은 호출자가 저장하지 않는다. */
async function fetchChallengesWithToken(url, token) {
    const base = baseUrl(url);
    try {
        const json = await safeJson(`${base}/api/v1/challenges`, { headers: { Authorization: `Token ${token}` } });
        if (json?.success && Array.isArray(json.data)) {
            return { platform: "ctfd", challenges: json.data.map((item) => ({ externalId: String(item.id), name: String(item.name ?? "").trim(), category: String(item.category ?? "misc").trim() })).filter((item) => item.name) };
        }
    }
    catch { /* rCTF 확인 */ }
    const json = await safeJson(`${base}/api/v2/challs`, { headers: { Authorization: `Bearer ${token}` } });
    if (!Array.isArray(json?.data))
        throw new Error("CTFd/rCTF 읽기 토큰으로 문제를 가져오지 못했습니다.");
    return { platform: "rctf", challenges: json.data.map((item) => ({ externalId: String(item.id), name: String(item.name ?? "").trim(), category: String(item.category ?? "misc").trim() })).filter((item) => item.name) };
}
/** 공개 점수판만 조회한다. 인증·세션 생성·제출 요청은 전혀 하지 않는다. */
async function fetchPublicScoreboard(platform, url) {
    const base = baseUrl(url);
    if (platform === "ctfd") {
        const json = await safeJson(`${base}/api/v1/scoreboard/top/10`);
        const rows = Array.isArray(json?.data) ? json.data : [];
        return rows.map((item, index) => ({
            name: String(item.name ?? item.account_name ?? "Unknown"),
            score: Number(item.score ?? 0),
            rank: Number(item.pos ?? item.rank ?? index + 1),
        }));
    }
    if (platform === "rctf") {
        const json = await safeJson(`${base}/api/v2/leaderboard/now?limit=10&offset=0`);
        const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.data?.leaderboard) ? json.data.leaderboard : [];
        return rows.map((item, index) => ({
            name: String(item.name ?? item.teamName ?? "Unknown"),
            score: Number(item.score ?? 0),
            rank: Number(item.globalPlace ?? item.rank ?? index + 1),
        }));
    }
    return [];
}
