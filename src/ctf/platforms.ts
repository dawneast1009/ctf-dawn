import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type PlatformKind = "ctfd" | "rctf" | "hspace" | "generic";
export type ChallengeAuth = { type: "token" | "session"; value: string };

export interface RemoteChallenge {
  externalId: string;
  name: string;
  category: string;
  description?: string;
  files?: RemoteChallengeFile[];
}

export interface RemoteChallengeFile {
  id: string;
  name: string;
  url: string;
}

export interface ScoreboardRow {
  name: string;
  score: number;
  rank: number;
}

export interface RemoteContestSchedule {
  startsAt: number;
  endsAt: number;
}

const USER_AGENT = "discord-ctf-bot/1.0 (read-only monitor)";

class RemoteHttpError extends Error {
  constructor(readonly status: number, readonly remoteMessage?: string) {
    super(`HTTP_${status}`);
  }
}

function isCtfdNotStarted(error: unknown): boolean {
  return error instanceof RemoteHttpError && error.status === 403 && /not started/i.test(error.remoteMessage ?? "");
}

function allowPrivateHosts(): boolean {
  return process.env.CTF_ALLOW_PRIVATE_HOSTS?.trim().toLowerCase() === "true";
}

function insecureHttpHosts(): Set<string> {
  return new Set((process.env.CTF_ALLOW_INSECURE_HTTP_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
      || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
  }
  return normalized === "localhost" || normalized.endsWith(".localhost")
    || normalized.endsWith(".local") || normalized.endsWith(".internal");
}

function parsedRemoteUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("올바른 HTTPS 대회 주소를 입력하세요."); }
  const insecureHttpAllowed = url.protocol === "http:" && insecureHttpHosts().has(url.host.toLowerCase());
  if ((url.protocol !== "https:" && !insecureHttpAllowed) || url.username || url.password) throw new Error("대회 주소는 사용자정보가 없는 HTTPS URL이어야 합니다.");
  if (!allowPrivateHosts() && isPrivateAddress(url.hostname)) throw new Error("localhost와 사설 네트워크 주소는 사용할 수 없습니다.");
  return url;
}

export async function assertSafeRemoteUrl(input: string): Promise<void> {
  const url = parsedRemoteUrl(input);
  if (allowPrivateHosts() || isIP(url.hostname.replace(/^\[|\]$/g, ""))) return;
  let addresses;
  try { addresses = await lookup(url.hostname, { all: true, verbatim: true }); }
  catch { throw new Error("대회 주소의 호스트를 확인할 수 없습니다."); }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("사설 네트워크로 연결되는 대회 주소는 사용할 수 없습니다.");
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  let current = parsedRemoteUrl(url);
  const requestHeaders = new Headers(init.headers);
  const hasSensitiveHeaders = requestHeaders.has("authorization") || requestHeaders.has("cookie");
  for (let redirects = 0; redirects <= 4; redirects++) {
    await assertSafeRemoteUrl(current.toString());
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("REDIRECT_WITHOUT_LOCATION");
    const next = parsedRemoteUrl(new URL(location, current).toString());
    if (hasSensitiveHeaders && next.origin !== current.origin) throw new Error("AUTH_CROSS_ORIGIN_REDIRECT");
    await response.body?.cancel();
    current = next;
  }
  throw new Error("TOO_MANY_REDIRECTS");
}

async function safeFileFetch(url: string, init: RequestInit): Promise<Response> {
  let current = parsedRemoteUrl(url);
  const requestHeaders = new Headers(init.headers);
  for (let redirects = 0; redirects <= 4; redirects++) {
    await assertSafeRemoteUrl(current.toString());
    const response = await fetch(current, { ...init, headers: requestHeaders, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("REDIRECT_WITHOUT_LOCATION");
    const next = parsedRemoteUrl(new URL(location, current).toString());
    if (next.origin !== current.origin) {
      requestHeaders.delete("authorization");
      requestHeaders.delete("cookie");
    }
    await response.body?.cancel();
    current = next;
  }
  throw new Error("TOO_MANY_REDIRECTS");
}

async function safeJson(url: string, init: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await safeFetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    if (response.status === 429) throw new Error("RATE_LIMITED");
    if (!response.ok) {
      let remoteMessage: string | undefined;
      try {
        const body = await response.json();
        if (typeof body?.message === "string") remoteMessage = body.message;
      } catch { /* 상태 코드만 사용 */ }
      throw new RemoteHttpError(response.status, remoteMessage);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function safeText(url: string, init: RequestInit = {}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await safeFetch(url, {
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
  const url = parsedRemoteUrl(input.trim());
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function ctfdFile(base: string, input: unknown): RemoteChallengeFile | null {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
  const location = typeof input === "string" ? input : typeof record?.location === "string" ? record.location : undefined;
  if (!location) return null;
  let url: URL;
  try { url = parsedRemoteUrl(new URL(location, `${base}/`).toString()); } catch { return null; }
  const pathName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "challenge-file");
  const name = typeof record?.name === "string" && record.name.trim() ? record.name.trim() : pathName;
  const identity = typeof record?.sha1sum === "string" && record.sha1sum ? record.sha1sum : url.pathname;
  return { id: identity, name, url: url.toString() };
}

function mapCtfdChallenge(base: string, item: any): RemoteChallenge {
  const challenge: RemoteChallenge = {
    externalId: String(item.id),
    name: String(item.name ?? "").trim(),
    category: String(item.category ?? "misc").trim(),
  };
  if (typeof item.description === "string") challenge.description = item.description;
  if (Array.isArray(item.files)) challenge.files = item.files.map((file: unknown) => ctfdFile(base, file)).filter((file: RemoteChallengeFile | null): file is RemoteChallengeFile => file !== null);
  return challenge;
}

export function ctfdSessionCookieHeader(input: string): string {
  const value = input.trim();
  if (!value || /[\r\n]/.test(value)) throw new Error("올바른 CTFd session 쿠키값을 입력하세요.");
  const sessionPart = value
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("session="));
  const sessionValue = sessionPart ? sessionPart.slice(sessionPart.indexOf("=") + 1).trim() : value;
  if (!sessionValue || sessionValue.includes(";")) throw new Error("올바른 CTFd session 쿠키값을 입력하세요.");
  return `session=${sessionValue}`;
}

function authHeaders(platform: PlatformKind, auth?: ChallengeAuth): Record<string, string> | undefined {
  if (!auth) return undefined;
  if (auth.type === "session") {
    if (platform !== "ctfd") throw new Error("세션 쿠키 인증은 CTFd에서만 사용할 수 있습니다.");
    return { Cookie: ctfdSessionCookieHeader(auth.value) };
  }
  if (platform === "ctfd") return { Authorization: `Token ${auth.value}` };
  if (platform === "rctf") return { Authorization: `Bearer ${auth.value}` };
  if (platform === "hspace") return { Cookie: `Access-Token=${auth.value}` };
  return undefined;
}

async function verifyCtfdAuth(base: string, auth?: ChallengeAuth): Promise<void> {
  if (!auth) return;
  const headers = authHeaders("ctfd", auth);
  const json = await safeJson(`${base}/api/v1/users/me`, headers ? { headers } : undefined);
  if (!json?.success || !json.data) throw new Error("CTFd 인증정보를 확인하지 못했습니다.");
}

function remoteTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const numeric = typeof value === "number" ? value : value.trim() && Number(value);
  if (typeof numeric === "number" && Number.isFinite(numeric)) {
    const milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
    return milliseconds > 0 ? Math.round(milliseconds) : undefined;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function ctfdInitValue(html: string, key: "start" | "end"): unknown {
  const initIndex = html.search(/(?:window\.)?init\s*=|CTFd\.init\s*\(/i);
  if (initIndex < 0) return undefined;
  const initBlock = html.slice(initIndex, initIndex + 20_000);
  const match = initBlock.match(new RegExp(`["']?${key}["']?\\s*:\\s*(null|-?\\d+(?:\\.\\d+)?|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, "i"));
  if (!match) return undefined;
  if (match[1].startsWith("'")) return match[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  try { return JSON.parse(match[1]); } catch { return undefined; }
}

/** CTFd 기본 테마가 window.init에 공개하는 ISO8601/Unix 일정을 읽는다. */
export function parseCtfdSchedulePage(html: string): RemoteContestSchedule | undefined {
  const startsAt = remoteTimestamp(ctfdInitValue(html, "start"));
  const endsAt = remoteTimestamp(ctfdInitValue(html, "end"));
  if (!startsAt || !endsAt || endsAt <= startsAt) return undefined;
  return { startsAt, endsAt };
}

export async function fetchCtfdContestSchedule(url: string, auth?: ChallengeAuth): Promise<RemoteContestSchedule | undefined> {
  const headers = authHeaders("ctfd", auth);
  const html = await safeText(baseUrl(url), headers ? { headers } : undefined);
  return parseCtfdSchedulePage(html);
}

export async function fetchCtfdChallengeDetails(url: string, challengeId: string, auth?: ChallengeAuth): Promise<RemoteChallenge> {
  const base = baseUrl(url);
  const headers = authHeaders("ctfd", auth);
  const json = await safeJson(`${base}/api/v1/challenges/${encodeURIComponent(challengeId)}`, headers ? { headers } : undefined);
  if (!json?.success || !json.data || Array.isArray(json.data)) throw new Error("CTFd 문제 상세 형식이 아닙니다.");
  const challenge = mapCtfdChallenge(base, json.data);
  if (!challenge.name) throw new Error("CTFd 문제 상세 형식이 아닙니다.");
  return challenge;
}

export async function fetchCtfdChallengeDetailsBatch(
  url: string,
  challenges: RemoteChallenge[],
  selectedIds: Set<string>,
  auth?: ChallengeAuth,
): Promise<{ challenges: RemoteChallenge[]; failedIds: string[] }> {
  const hydrated: RemoteChallenge[] = [];
  const failedIds: string[] = [];
  for (const challenge of challenges) {
    if (!selectedIds.has(challenge.externalId)) {
      hydrated.push(challenge);
      continue;
    }
    try { hydrated.push(await fetchCtfdChallengeDetails(url, challenge.externalId, auth)); }
    catch { hydrated.push(challenge); failedIds.push(challenge.externalId); }
  }
  return { challenges: hydrated, failedIds };
}

export async function downloadRemoteChallengeFile(
  contestUrl: string,
  file: RemoteChallengeFile,
  auth?: ChallengeAuth,
  maxBytes = 10 * 1024 * 1024,
): Promise<{ name: string; data: Buffer }> {
  const source = parsedRemoteUrl(baseUrl(contestUrl));
  const target = parsedRemoteUrl(file.url);
  const headers = target.origin === source.origin ? authHeaders("ctfd", auth) : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await safeFileFetch(target.toString(), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream", ...(headers ?? {}) },
      signal: controller.signal,
    });
    if (response.status === 429) throw new Error("RATE_LIMITED");
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      throw new Error("FILE_TOO_LARGE");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("FILE_TOO_LARGE");
        }
        chunks.push(Buffer.from(value));
      }
    }
    const data = Buffer.concat(chunks, size);
    const name = file.name.replace(/[\\/\r\n\0]/g, "_").slice(0, 200) || "challenge-file";
    return { name, data };
  } finally {
    clearTimeout(timeout);
  }
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
export async function fetchPublicChallenges(platform: PlatformKind, url: string, authInput?: ChallengeAuth | string): Promise<RemoteChallenge[]> {
  const base = baseUrl(url);
  const auth = typeof authInput === "string" ? { type: "token" as const, value: authInput } : authInput;
  if (platform === "ctfd") {
    const headers = authHeaders(platform, auth);
    let json;
    try { json = await safeJson(`${base}/api/v1/challenges`, headers ? { headers } : undefined); }
    catch (error) {
      if (isCtfdNotStarted(error)) {
        await verifyCtfdAuth(base, auth);
        return [];
      }
      throw error;
    }
    if (!json?.success || !Array.isArray(json.data)) throw new Error("CTFd 문제 목록 형식이 아닙니다.");
    return json.data.map((item: any) => mapCtfdChallenge(base, item)).filter((item: RemoteChallenge) => item.name);
  }
  if (platform === "rctf") {
    const headers = authHeaders(platform, auth);
    const json = await safeJson(`${base}/api/v2/challs`, headers ? { headers } : undefined);
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
    if (!auth) throw new Error("HSPACE_ACCESS_TOKEN이 필요합니다.");
    const html = await safeText(base, { headers: authHeaders(platform, auth) });
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
      return { platform: "ctfd", challenges: json.data.map((item: any) => mapCtfdChallenge(base, item)).filter((item: RemoteChallenge) => item.name) };
    }
  } catch (error) {
    if (isCtfdNotStarted(error)) {
      await verifyCtfdAuth(base, { type: "token", value: token });
      return { platform: "ctfd", challenges: [] };
    }
    /* rCTF 확인 */
  }
  const json = await safeJson(`${base}/api/v2/challs`, { headers: { Authorization: `Bearer ${token}` } });
  if (!Array.isArray(json?.data)) throw new Error("CTFd/rCTF 읽기 토큰으로 문제를 가져오지 못했습니다.");
  return { platform: "rctf", challenges: json.data.map((item: any) => ({ externalId: String(item.id), name: String(item.name ?? "").trim(), category: String(item.category ?? "misc").trim() })).filter((item: RemoteChallenge) => item.name) };
}

/** 브라우저에서 복사한 CTFd session 쿠키값으로 읽기 전용 문제 목록을 조회한다. */
export async function fetchChallengesWithSession(url: string, sessionCookie: string): Promise<{ platform: "ctfd"; challenges: RemoteChallenge[] }> {
  const base = baseUrl(url);
  try {
    const json = await safeJson(`${base}/api/v1/challenges`, { headers: { Cookie: ctfdSessionCookieHeader(sessionCookie) } });
    if (json?.success && Array.isArray(json.data)) {
      return {
        platform: "ctfd",
        challenges: json.data
          .map((item: any) => mapCtfdChallenge(base, item))
          .filter((item: RemoteChallenge) => item.name),
      };
    }
  } catch { /* 아래에서 인증 오류를 사용자에게 설명 */ }
  throw new Error("CTFd 세션 쿠키로 문제를 가져오지 못했습니다. 로그인 상태와 session 쿠키값을 확인하세요.");
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
