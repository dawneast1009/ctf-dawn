export type PlatformKind = "ctfd" | "rctf" | "hspace" | "generic";

export interface RemoteChallenge {
  externalId: string;
  name: string;
  category: string;
}

export interface ScoreboardRow {
  name: string;
  score: number;
  rank: number;
}

const USER_AGENT = "discord-ctf-bot/1.0 (read-only monitor)";

async function safeJson(url: string, init: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    if (response.status === 429) throw new Error("RATE_LIMITED");
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function safeText(url: string, init: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html", ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    if (response.status === 429) throw new Error("RATE_LIMITED");
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function baseUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

function hspaceCompetitionId(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.hostname !== "forge.hspace.io") return null;
    return url.pathname.match(/^\/competitions\/([a-f\d]{24})(?:\/|$)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/gi, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export function parseHspaceChallengePage(html: string, competitionId: string): RemoteChallenge[] {
  const cards = new Map<string, RemoteChallenge>();
  const cardPattern = new RegExp(`<a\\b[^>]*href=["']/competitions/${competitionId}/challenges/([a-f\\d]{24})["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
  for (const match of html.matchAll(cardPattern)) {
    const parts = match[2]
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .split(/<[^>]+>/)
      .map((value) => decodeHtml(value).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    cards.set(match[1], { externalId: match[1], category: parts[0], name: parts[1] });
  }
  return [...cards.values()];
}

export async function detectPlatform(url: string): Promise<PlatformKind> {
  const base = baseUrl(url);
  if (hspaceCompetitionId(base)) return "hspace";
  try {
    const json = await safeJson(`${base}/api/v1/challenges`);
    if (json?.success && Array.isArray(json.data)) return "ctfd";
  } catch { /* 다음 형식 확인 */ }
  try {
    const json = await safeJson(`${base}/api/v2/challs`);
    if (Array.isArray(json?.data)) return "rctf";
  } catch { /* 알 수 없는 플랫폼 */ }
  return "generic";
}

/** 인증이 필요 없는 읽기 전용 문제 목록. 로그인 요청이나 플래그 제출은 하지 않는다. */
export async function fetchPublicChallenges(platform: PlatformKind, url: string, hspaceAccessToken?: string): Promise<RemoteChallenge[]> {
  const base = baseUrl(url);
  if (platform === "ctfd") {
    const json = await safeJson(`${base}/api/v1/challenges`, hspaceAccessToken ? { headers: { Authorization: `Token ${hspaceAccessToken}` } } : undefined);
    if (!json?.success || !Array.isArray(json.data)) throw new Error("CTFd 문제 목록 형식이 아닙니다.");
    return json.data.map((item: any) => ({
      externalId: String(item.id),
      name: String(item.name ?? "").trim(),
      category: String(item.category ?? "misc").trim(),
    })).filter((item: RemoteChallenge) => item.name);
  }
  if (platform === "rctf") {
    const json = await safeJson(`${base}/api/v2/challs`, hspaceAccessToken ? { headers: { Authorization: `Bearer ${hspaceAccessToken}` } } : undefined);
    if (!Array.isArray(json?.data)) throw new Error("rCTF 문제 목록 형식이 아닙니다.");
    return json.data.map((item: any) => ({
      externalId: String(item.id),
      name: String(item.name ?? "").trim(),
      category: String(item.category ?? "misc").trim(),
    })).filter((item: RemoteChallenge) => item.name);
  }
  if (platform === "hspace") {
    const competitionId = hspaceCompetitionId(base);
    if (!competitionId) throw new Error("HSPACE FORGE 대회 URL 형식이 아닙니다.");
    if (!hspaceAccessToken) throw new Error("HSPACE_ACCESS_TOKEN이 필요합니다.");
    const html = await safeText(base, { headers: { Cookie: `Access-Token=${hspaceAccessToken}` } });
    const challenges = parseHspaceChallengePage(html, competitionId);
    if (!challenges.length) throw new Error("HSPACE 로그인 페이지에서 문제 카드를 찾지 못했습니다. 새 Access-Token을 확인하세요.");
    return challenges;
  }
  throw new Error("이 플랫폼은 공개 문제 API 자동 감시를 지원하지 않습니다.");
}

/** 한 번 입력한 읽기 토큰으로만 조회한다. 토큰은 호출자가 저장하지 않는다. */
export async function fetchChallengesWithToken(url: string, token: string): Promise<{ platform: PlatformKind; challenges: RemoteChallenge[] }> {
  const base = baseUrl(url);
  try {
    const json = await safeJson(`${base}/api/v1/challenges`, { headers: { Authorization: `Token ${token}` } });
    if (json?.success && Array.isArray(json.data)) {
      return { platform: "ctfd", challenges: json.data.map((item: any) => ({ externalId: String(item.id), name: String(item.name ?? "").trim(), category: String(item.category ?? "misc").trim() })).filter((item: RemoteChallenge) => item.name) };
    }
  } catch { /* rCTF 확인 */ }
  const json = await safeJson(`${base}/api/v2/challs`, { headers: { Authorization: `Bearer ${token}` } });
  if (!Array.isArray(json?.data)) throw new Error("CTFd/rCTF 읽기 토큰으로 문제를 가져오지 못했습니다.");
  return { platform: "rctf", challenges: json.data.map((item: any) => ({ externalId: String(item.id), name: String(item.name ?? "").trim(), category: String(item.category ?? "misc").trim() })).filter((item: RemoteChallenge) => item.name) };
}

/** 공개 점수판만 조회한다. 인증·세션 생성·제출 요청은 전혀 하지 않는다. */
export async function fetchPublicScoreboard(platform: PlatformKind, url: string): Promise<ScoreboardRow[]> {
  const base = baseUrl(url);
  if (platform === "ctfd") {
    const json = await safeJson(`${base}/api/v1/scoreboard/top/10`);
    const rows = Array.isArray(json?.data) ? json.data : [];
    return rows.map((item: any, index: number) => ({
      name: String(item.name ?? item.account_name ?? "Unknown"),
      score: Number(item.score ?? 0),
      rank: Number(item.pos ?? item.rank ?? index + 1),
    }));
  }
  if (platform === "rctf") {
    const json = await safeJson(`${base}/api/v2/leaderboard/now?limit=10&offset=0`);
    const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.data?.leaderboard) ? json.data.leaderboard : [];
    return rows.map((item: any, index: number) => ({
      name: String(item.name ?? item.teamName ?? "Unknown"),
      score: Number(item.score ?? 0),
      rank: Number(item.globalPlace ?? item.rank ?? index + 1),
    }));
  }
  return [];
}
