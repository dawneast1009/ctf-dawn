import { createHash } from "node:crypto";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import iconv from "iconv-lite";
import type { EventItem } from "../store";
import {
  classifyEvent,
  compactText,
  extractDateTimes,
  isEventAnnouncement,
  isSecurityNews,
  looksLikeResultNews,
  normalizeGenres,
  parseDate,
  parseEventNotice,
  participationMode,
  periodAfterLabel,
  sha256,
  stripHtml,
  type EventKind,
} from "./core";

const USER_AGENT = "discord-ctf-bot/2.0 (+Discord security event aggregator)";
let REQUEST_TIMEOUT_MS = 20_000;
let DETAIL_CONCURRENCY = 1;
const SECURITY_RE = /정보보호|정보보안|사이버보안|보안|해킹|취약점|침해사고|랜섬웨어|악성코드|제로데이|CVE|CTF|해커톤|컨퍼런스|세미나|공모전|경진대회|AI|인공지능/i;
const BLOCKED_URL_RE = /(?:youtube\.com|youtu\.be|instagram\.com|facebook\.com|x\.com|twitter\.com|tiktok\.com|pinterest\.)/i;
const EDITORIAL_HOST_RE = /^(?:news\.google\.com|(?:www\.)?dailysecu\.com|(?:www\.)?boannews\.com|(?:www\.)?wikitree\.co\.kr|(?:www\.)?etnews\.com|(?:www\.)?zdnet\.co\.kr|(?:www\.)?yna\.co\.kr|(?:www\.)?news1\.kr|(?:www\.)?newsis\.com|(?:www\.)?mk\.co\.kr|(?:www\.)?hankyung\.com|(?:www\.)?edaily\.co\.kr|(?:www\.)?fnnews\.com|(?:www\.)?donga\.com|(?:www\.)?chosun\.com|(?:www\.)?joongang\.co\.kr)$/i;

export interface CollectorOptions {
  lookaheadDays: number;
  enableKctf: boolean;
  enableAutoDiscovery: boolean;
  discoveryFeedUrls: string[];
  extraFeedUrls: string[];
  eventPageUrls: string[];
  enableSearchApiDiscovery: boolean;
  searchApiMaxResults: number;
  naverClientId?: string;
  naverClientSecret?: string;
  googleApiKey?: string;
  googleCseId?: string;
  bingApiKey?: string;
  bingEndpoint: string;
  sourceTimeoutMs?: number;
  sourceConcurrency: number;
}

export interface CollectionResult {
  items: EventItem[];
  errors: string[];
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  publishedAt?: number;
}

interface SearchResult {
  provider: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: number;
}

interface SearchQuery {
  name: string;
  query: string;
  kind: EventKind;
  requireDate: boolean;
}

const SEARCH_QUERIES: SearchQuery[] = [
  { name: "검색API-CTF", query: "CTF 대회 모집 OR 해킹방어대회 접수 OR 사이버공격방어대회", kind: "ctf", requireDate: true },
  { name: "검색API-CTF-해외", query: "CTF competition registration cybersecurity challenge", kind: "ctf", requireDate: true },
  { name: "검색API-AI대회", query: "AI 경진대회 모집 OR 인공지능 공모전 OR 데이터 경진대회 접수", kind: "ai", requireDate: true },
  { name: "검색API-AI보안", query: "AI 보안 해커톤 OR AI security hackathon OR 사이버보안 AI 경진대회", kind: "ai", requireDate: true },
  { name: "검색API-해커톤", query: "정보보안 해커톤 모집 OR 사이버보안 해커톤 참가", kind: "hackathon", requireDate: true },
  { name: "검색API-컨퍼런스", query: "정보보안 컨퍼런스 OR 사이버보안 세미나 OR 보안 포럼", kind: "conference", requireDate: true },
  { name: "검색API-고등학생보안", query: "고등학생 정보보안 모집 OR 고등학교 사이버보안 캠프 OR 청소년 보안 경진대회 접수", kind: "security", requireDate: true },
  { name: "검색API-보안뉴스", query: "정보보안 취약점 랜섬웨어 침해사고 보안패치", kind: "news", requireDate: false },
];

function googleNewsRss(query: string): string {
  const params = new URLSearchParams({ q: query, hl: "ko", gl: "KR", ceid: "KR:ko" });
  return `https://news.google.com/rss/search?${params}`;
}

const DEFAULT_DISCOVERY_FEEDS: Array<{ name: string; url: string; kind: EventKind; max: number }> = [
  { name: "자동탐색-CTF", url: googleNewsRss('(“CTF” OR “해킹방어대회” OR “사이버공격방어대회” OR “화이트햇 콘테스트”)'), kind: "ctf", max: 8 },
  { name: "자동탐색-AI대회", url: googleNewsRss('(“AI 경진대회” OR “인공지능 공모전” OR “AI 해커톤” OR “데이터 경진대회”)'), kind: "ai", max: 8 },
  { name: "자동탐색-해커톤", url: googleNewsRss('(“정보보안 해커톤” OR “보안 해커톤” OR “사이버보안 해커톤” OR “AI 해커톤”)'), kind: "hackathon", max: 8 },
  { name: "자동탐색-컨퍼런스", url: googleNewsRss('(“정보보안 컨퍼런스” OR “사이버보안 컨퍼런스” OR “보안 세미나” OR “보안 포럼”)'), kind: "conference", max: 8 },
  { name: "자동탐색-보안뉴스", url: googleNewsRss('(“정보보안” OR “사이버보안” OR “취약점” OR “랜섬웨어” OR “침해사고”)'), kind: "news", max: 12 },
];

const OFFICIAL_BOARDS: Array<{
  name: string;
  url: string;
  kind: EventKind;
  linkPattern: RegExp;
  titlePattern: RegExp;
  audiencePattern?: RegExp;
}> = [
  {
    name: "KISIA 교육",
    url: "https://kisia.or.kr/talent_support/education_apply/",
    kind: "security",
    linkPattern: /\/talent_support\/education_apply\/(?:submit\/)?\d+\/?/i,
    titlePattern: /정보보호|정보보안|사이버보안|AI보안|화이트햇|교육생|아카데미|캠프|교육과정/i,
    audiencePattern: /고등학생|고교생|청소년|중고등학생|만\s*1[5-9]세/i,
  },
  {
    name: "KISIA 유관기관",
    url: "https://kisia.or.kr/announcement/relative/",
    kind: "security",
    linkPattern: /\/announcement\/relative\/\d+\//i,
    titlePattern: /정보보호|정보보안|사이버보안|화이트햇|BoB|교육생|영재|캠프|공모전|경진대회/i,
    audiencePattern: /고등학생|고교생|청소년|중고등학생|만\s*2?6세\s*이하/i,
  },
  {
    name: "KISIA 협회 행사",
    url: "https://kisia.or.kr/announcement/association/",
    kind: "conference",
    linkPattern: /\/announcement\/association\/\d+\//i,
    titlePattern: /정보보호|정보보안|사이버보안|conference|컨퍼런스|세미나|포럼|워크숍|전시회/i,
  },
  {
    name: "국가정보원 보안대회",
    url: "https://www.nis.go.kr/CM/1_4/list.do",
    kind: "ctf",
    linkPattern: /\/CM\/1_4\/view\.do\?seq=\d+/i,
    titlePattern: /사이버공격방어대회|CCE|화이트햇\s*콘테스트|해킹방어대회|CTF/i,
  },
  {
    name: "WACON",
    url: "https://akj.or.kr/article/?cate=25",
    kind: "ctf",
    linkPattern: /akj\.or\.kr\/article\//i,
    titlePattern: /WACON|와콘|사이버\s*보안\s*모의\s*해킹/i,
  },
  {
    name: "KISA 정보보안 소식",
    url: "https://www.kisa.or.kr/",
    kind: "news",
    linkPattern: /\/(?:401|402)\/form\?.*postSeq=\d+/i,
    titlePattern: /정보보호|정보보안|사이버|해킹|취약점|침해사고|랜섬웨어|악성코드|개인정보|암호|보안/i,
  },
  {
    name: "서울 정보보호영재교육",
    url: "https://ssei.sen.go.kr/sge/",
    kind: "security",
    linkPattern: /ssei\.sen\.go\.kr\/sge\//i,
    titlePattern: /정보보호|정보보안|사이버보안|화이트해커|영재교육원|보안\s*캠프/i,
    audiencePattern: /고등학생|고교생|중.?고등학생|청소년/i,
  },
  {
    name: "건양대 정보보호영재교육원",
    url: "https://youngjae.konyang.ac.kr/youngjae/sub02_01.do",
    kind: "security",
    linkPattern: /youngjae\.konyang\.ac\.kr\/youngjae\//i,
    titlePattern: /정보보호|정보보안|사이버보안|화이트해커|교육생|모집|캠프|특강/i,
    audiencePattern: /고등학생|고교생|중.?고등학생|청소년/i,
  },
];

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${timeoutMs}ms 시간 제한 초과`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleInBatches<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = [];
  const width = Math.max(1, concurrency);
  for (let index = 0; index < tasks.length; index += width) {
    results.push(...await Promise.allSettled(tasks.slice(index, index + width).map((task) => task())));
  }
  return results;
}

async function request(url: string | URL, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  return withTimeout(async (signal) => {
    const response = await fetch(url, {
      ...init,
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,text/html,application/rss+xml,application/xml",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return response;
  }, timeoutMs);
}

async function responseText(response: Response): Promise<string> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const header = response.headers.get("content-type") ?? "";
  const head = buffer.subarray(0, 300).toString("ascii");
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(header)?.[1] ?? /encoding\s*=\s*["']([^"']+)/i.exec(head)?.[1];
  const encoding = charset && iconv.encodingExists(charset) ? charset : "utf-8";
  return iconv.decode(buffer, encoding);
}

async function fetchText(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
  return responseText(await request(url, {}, timeoutMs));
}

async function fetchJson<T = unknown>(url: string | URL, init: RequestInit = {}): Promise<T> {
  const response = await request(url, init);
  return (await response.json()) as T;
}

function absoluteUrl(base: string, href: string): string | undefined {
  if (!href || /^(?:#|mailto:|javascript:)/i.test(href)) return undefined;
  try {
    const url = new URL(href, base);
    if (url.hostname === "www.kisia.or.kr") url.hostname = "kisia.or.kr";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isEditorialUrl(value: string): boolean {
  try {
    return EDITORIAL_HOST_RE.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function objectText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    return objectText(row["#text"] ?? row.__cdata ?? row._ ?? row.href ?? "");
  }
  return "";
}

function list<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function feedItems(xml: string): FeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true, cdataPropName: "__cdata" });
  let root: any;
  try {
    root = parser.parse(xml);
  } catch {
    return [];
  }
  const rows = list(root?.rss?.channel?.item ?? root?.feed?.entry);
  return rows.map((row: any) => {
    const linkValue = Array.isArray(row?.link) ? row.link[0] : row?.link;
    const link = objectText(linkValue?.["@_href"] ?? linkValue ?? row?.id);
    return {
      title: stripHtml(objectText(row?.title)),
      link,
      description: stripHtml(objectText(row?.description ?? row?.summary ?? row?.content)),
      publishedAt: parseDate(objectText(row?.pubDate ?? row?.published ?? row?.updated ?? row?.date)),
    };
  });
}

export async function fetchNoticeText(url: string): Promise<string> {
  const html = await fetchText(url, 10_000);
  const $ = load(html);
  $("script,style,noscript,svg,iframe").remove();
  const title = $("title").first().text().trim();
  const main = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body");
  const links = main
    .find("a[href]")
    .slice(0, 30)
    .map((_, node) => {
      const anchor = $(node);
      const href = absoluteUrl(url, anchor.attr("href") ?? "");
      const text = anchor.text().replace(/\s+/g, " ").trim();
      return href ? (text ? `${text}: ${href}` : href) : "";
    })
    .get()
    .filter(Boolean);
  return compactText([url, title, main.text(), links.length ? `관련 링크\n${[...new Set(links)].join("\n")}` : ""].filter(Boolean).join("\n"));
}

async function fetchCtftimeRange(start: number, finish: number, limit: number): Promise<any[]> {
  const url = new URL("https://ctftime.org/api/v1/events/");
  url.search = new URLSearchParams({ start: String(start), finish: String(finish), limit: String(limit) }).toString();
  const rows = await fetchJson<unknown>(url);
  return Array.isArray(rows) ? rows : [];
}

async function fetchCtftime(lookaheadDays: number): Promise<EventItem[]> {
  const now = Math.floor(Date.now() / 1000);
  const [future, recent] = await Promise.all([
    fetchCtftimeRange(now - 12 * 3600, now + lookaheadDays * 86_400, 200),
    fetchCtftimeRange(now - 14 * 86_400, now, 100),
  ]);
  const rows = new Map([...recent, ...future].map((row) => [String(row.id), row]));
  return [...rows.values()].flatMap((row) => {
    if (!row?.id || !row?.title) return [];
    const link = String(row.url || row.ctftime_url || "https://ctftime.org/event/list/");
    const summary = stripHtml(String(row.description ?? ""));
    const organizer = Array.isArray(row.organizers) ? row.organizers.map((item: any) => item?.name).filter(Boolean).join(", ") : undefined;
    const poster = row.logo ? absoluteUrl("https://ctftime.org/", String(row.logo)) : undefined;
    const startsAt = parseDate(row.start);
    const endsAt = parseDate(row.finish);
    return [{
      id: sha256(`CTFtime:${row.id}`), guildId: "", title: String(row.title), link, source: "CTFtime", kind: "ctf",
      summary, organizer, posterUrl: poster, startsAt, endsAt, publishedAt: startsAt ?? Date.now(),
      location: row.location ? String(row.location) : undefined,
      participationMode: participationMode(row.format, row.location, summary),
      genres: normalizeGenres(row.categories ?? row.tags, `${row.format ?? ""} ${summary} ${row.title}`),
    } satisfies EventItem];
  });
}

async function fetchJsonFeed(url: string): Promise<EventItem[]> {
  const payload: any = await fetchJson(url);
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [];
  return rows.flatMap((row: any) => {
    if (!row?.name) return [];
    const link = String(row.url ?? url);
    const startsAt = parseDate(row.start_at);
    const genres = normalizeGenres(row.genres ?? row.categories ?? row.tags, String(row.description ?? ""));
    return [{
      id: String(row.id ?? sha256(`${row.name}|${row.start_at ?? ""}|${link}`)), guildId: "", title: String(row.name), link,
      source: String(row.source ?? new URL(url).hostname), kind: normalizeKind(row.event_type) ?? (genres.includes("AI") ? "ai" : "ctf"),
      summary: row.description ? String(row.description) : undefined, organizer: row.organizer ? String(row.organizer) : undefined,
      eligibility: row.eligibility ? String(row.eligibility) : undefined, registration: row.registration ? String(row.registration) : undefined,
      registrationUrl: row.registration_url ? String(row.registration_url) : undefined,
      registrationDeadline: parseDate(row.registration_deadline), startsAt, endsAt: parseDate(row.end_at), publishedAt: startsAt ?? Date.now(),
      posterUrl: row.poster_url ?? row.image_url, genres, teamLimit: row.team_limit ? String(row.team_limit) : undefined,
      participationMode: row.participation_mode ? String(row.participation_mode) : participationMode(row.format, row.location, row.description),
      location: row.location ? String(row.location) : undefined,
    } satisfies EventItem];
  });
}

function normalizeKind(value: unknown): EventKind | undefined {
  const raw = String(value ?? "").toLowerCase();
  const aliases: Record<string, EventKind> = {
    ctf: "ctf", ai: "ai", conference: "conference", hackathon: "hackathon", other: "security", security: "security", news: "news",
  };
  return aliases[raw];
}

function canonicalBoanLink(link: string): string | undefined {
  try {
    const parsed = new URL(link);
    const articleId = parsed.searchParams.get("idx");
    parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = articleId ? new URLSearchParams({ idx: articleId }).toString() : parsed.search;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function parseBoanNewsFeed(xml: string, now = Date.now()): EventItem[] {
  return feedItems(xml).slice(0, 10).flatMap((row) => {
    const link = canonicalBoanLink(row.link);
    if (!row.title || !link || !row.publishedAt || row.publishedAt < now - 30 * 86_400_000) return [];
    return [{
      id: sha256(link), guildId: "", title: row.title, link, source: "보안뉴스", kind: "news",
      summary: row.description.slice(0, 500) || undefined, publishedAt: row.publishedAt, startsAt: row.publishedAt,
    } satisfies EventItem];
  });
}

async function fetchBoanNews(): Promise<EventItem[]> {
  return parseBoanNewsFeed(await fetchText("https://www.boannews.com/media/news_rss.xml?mkind=1"));
}

function isKoreanCandidate(text: string, link: string): boolean {
  try {
    if (/\.(?:kr|ac\.kr|go\.kr|or\.kr|re\.kr)$/.test(new URL(link).hostname)) return true;
  } catch {
    return false;
  }
  return /대한민국|한국|국내|서울|부산|대전|인천|광주|대구|제주|세종|수원|판교|나주|전남|전북|경남|경북|충남|충북|동신대|동신대학교|대학교|고등학생|고등학교|고교생|특성화고|마이스터고|과학고|영재학교|한국인터넷진흥원|KISA|KISIA/i.test(text);
}

export function searchTitleMatchesKind(kind: EventKind, title: string): boolean {
  const eventSignal = /모집|접수|신청|참가|개최|안내|대회|경진|공모전|해커톤|컨퍼런스|세미나|포럼|캠프|교육생|아카데미|challenge|competition|conference|hackathon/i;
  if (!eventSignal.test(title)) return false;
  if (/부임|신임\s*교수|환영|논문\s*채택|연구\s*성과|수상|입상|성료/i.test(title)) return false;
  if (kind === "ctf") return /\bCTF\b|capture\s+the\s+flag|해킹\s*방어|사이버\s*(?:공격\s*)?방어|화이트햇\s*콘테스트|\bCCE\b|WACON/i.test(title);
  if (kind === "ai") return /(?:^|\W)AI(?:\W|$)|인공지능|머신러닝|데이터\s*(?:분석|경진)|DACON|데이콘/i.test(title) && /대회|경진|공모전|해커톤|challenge|competition/i.test(title);
  if (kind === "hackathon") return /해커톤|hackathon|아이디어톤|ideathon/i.test(title);
  if (kind === "conference") return /정보보안|정보보호|사이버보안|보안|CODEGATE|SECON/i.test(title) && /컨퍼런스|conference|세미나|포럼|forum|워크숍|전시회|개최/i.test(title);
  if (kind === "security") return /정보보안|정보보호|사이버보안|화이트햇|해킹|보안/i.test(title) && /모집|교육|캠프|아카데미|공모전|경진|멘토링|특강|워크숍/i.test(title);
  return isSecurityNews(title);
}

export function titleYearMatchesEvent(title: string, event: EventItem, now = Date.now()): boolean {
  const titleYear = Number(/(?:^|\D)(20\d{2})(?:\D|$)/.exec(title)?.[1]);
  if (!titleYear) return true;
  const currentYear = new Date(now + 9 * 60 * 60 * 1000).getUTCFullYear();
  if (titleYear < currentYear) return false;
  const target = event.registrationDeadline ?? event.startsAt ?? event.endsAt;
  if (!target) return true;
  return new Date(target + 9 * 60 * 60 * 1000).getUTCFullYear() === titleYear;
}

async function feedItemToEvent(feed: { name: string; kind: EventKind }, item: FeedItem, lookaheadDays: number): Promise<EventItem | undefined> {
  const combined = `${item.title}\n${item.description}\n${item.link}`;
  if (!item.title || !item.link || !SECURITY_RE.test(combined)) return undefined;
  if (feed.kind === "news") {
    if (!isSecurityNews(item.title, item.description) || (item.publishedAt && item.publishedAt < Date.now() - 14 * 86_400_000)) return undefined;
    return {
      id: sha256(item.link), guildId: "", title: item.title, link: item.link, source: feed.name, kind: "news",
      summary: item.description.slice(0, 500), publishedAt: item.publishedAt ?? Date.now(), startsAt: item.publishedAt ?? Date.now(),
    };
  }
  if (isEditorialUrl(item.link)) return undefined;
  if (!searchTitleMatchesKind(feed.kind, item.title)) return undefined;
  if (!isEventAnnouncement(item.title, item.description) || looksLikeResultNews(item.title, item.description)) return undefined;
  let notice = combined;
  try {
    const loaded = await fetchNoticeText(item.link);
    if (loaded.length > notice.length) notice = loaded;
  } catch {
    // 검색 요약만으로도 파싱 가능한 경우 계속 진행한다.
  }
  if (looksLikeResultNews(notice)) return undefined;
  let event: EventItem;
  try {
    event = parseEventNotice(notice, feed.name);
  } catch {
    return undefined;
  }
  event.kind = feed.kind;
  event.id = sha256(item.link);
  event.link ||= item.link;
  event.registrationUrl ||= event.link;
  event.summary ||= item.description.slice(0, 500);
  event.manual = false;
  if (!titleYearMatchesEvent(item.title, event)) return undefined;
  if (feed.kind === "hackathon" && !isKoreanCandidate(notice, item.link)) return undefined;
  const target = event.registrationDeadline ?? event.startsAt;
  if (!target || target < Date.now() - 3 * 86_400_000 || target > Date.now() + lookaheadDays * 86_400_000) return undefined;
  return event;
}

async function fetchDiscoveryFeed(feed: { name: string; url: string; kind: EventKind; max: number }, lookaheadDays: number): Promise<EventItem[]> {
  const items = feedItems(await fetchText(feed.url)).slice(0, feed.max);
  const converted = await settleInBatches(
    items.map((item) => () => feedItemToEvent(feed, item, lookaheadDays)),
    DETAIL_CONCURRENCY,
  );
  return converted.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

async function fetchKctf(): Promise<EventItem[]> {
  const base = "https://k-ctf.org/";
  const html = await fetchText(base, 10_000);
  const $ = load(html);
  const paths = new Set<string>();
  $('a[href^="/contests/"]').each((_, node) => {
    const href = $(node).attr("href") ?? "";
    if (/^\/contests\/[0-9a-f]+$/i.test(href)) paths.add(href);
  });
  for (const match of html.matchAll(/location\.href=['"](\/contests\/[0-9a-f]+)['"]/gi)) paths.add(match[1]);
  const details = await settleInBatches([...paths].map((path) => async () => {
    const url = new URL(path, base).toString();
    const detailHtml = await fetchText(url, 8_000);
    const detail = load(detailHtml);
    const title = detail("h1").first().text().replace(/\s+/g, " ").trim();
    if (!title) return undefined;
    const text = detail.root().text().replace(/\s+/g, " ");
    const description = detail(".multiline-text").first().text().trim() || undefined;
    const allDates = extractDateTimes(text);
    const registrationDates = periodAfterLabel(text, /신청\s*기간/i);
    const official = detail('a[href^="http"]').toArray().map((node) => detail(node).attr("href") ?? "").find((href) => !href.includes("k-ctf.org"));
    const poster = detail('img[alt*="포스터"]').first().attr("src");
    const kind: EventKind = /해커톤|hackathon/i.test(`${title} ${description ?? ""}`) ? "hackathon" : "ctf";
    return {
      id: sha256(`K-CTF:${path}`), guildId: "", title, link: official || url, source: "K-CTF", kind, summary: description,
      registration: registrationDates.length ? formatPeriod(registrationDates) : undefined,
      registrationUrl: official, registrationDeadline: registrationDates.at(-1), startsAt: allDates[0], endsAt: allDates.at(-1),
      publishedAt: allDates[0] ?? Date.now(), posterUrl: poster ? absoluteUrl(base, poster) : undefined,
      participationMode: participationMode(text), genres: normalizeGenres(undefined, `${title} ${description ?? ""}`), region: "kr",
    } satisfies EventItem;
  }), DETAIL_CONCURRENCY);
  return details.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

function formatKst(value: number): string {
  return `${new Date(value + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")} KST`;
}

function formatPeriod(values: number[]): string {
  if (!values.length) return "";
  return values.length > 1 ? `${formatKst(values[0])} ~ ${formatKst(values[1])}` : formatKst(values[0]);
}

async function fetchDacon(): Promise<EventItem[]> {
  const base = "https://dacon.io/";
  const html = await fetchText(base);
  const $ = load(html);
  const candidates = new Map<string, { title: string; poster?: string; text: string }>();
  $('a[href*="/competitions/official/"]').each((_, node) => {
    const anchor = $(node);
    const href = anchor.attr("href") ?? "";
    const id = /\/competitions\/official\/(\d+)\//.exec(href)?.[1];
    const text = anchor.text().replace(/\s+/g, " ").trim();
    if (!id || !/(?:종료|시작)까지\s*D-\d+/.test(text)) return;
    const image = anchor.find('img[alt$=" Image"]').first();
    const title = (image.attr("alt") ?? "").replace(/\s+Image$/, "").trim();
    if (title) candidates.set(id, { title, poster: image.attr("src"), text });
  });
  const details = await settleInBatches([...candidates].map(([id, card]) => async () => {
    const url = new URL(`competitions/official/${id}/overview/schedule`, base).toString();
    const detailHtml = await fetchText(url);
    const detail = load(detailHtml);
    const text = detail.root().text().replace(/\s+/g, " ");
    const period = periodAfterLabel(text, /대회\s*기간|예선\s*기간|대회\s*일정/i).slice(0, 2);
    let startsAt = period[0];
    let endsAt = period[1] ?? period[0];
    if (!startsAt) {
      const start = extractDateTimes(card.text)[0];
      const days = Number(/종료까지\s*D-(\d+)/.exec(card.text)?.[1]);
      if (!start || !Number.isFinite(days)) return undefined;
      startsAt = start;
      endsAt = Date.now() + days * 86_400_000;
    }
    const summary = detail('meta[name="description"]').attr("content")?.trim();
    return {
      id: sha256(`DACON:${id}`), guildId: "", title: card.title, link: url, source: "DACON", kind: "ai", summary,
      startsAt, endsAt, publishedAt: startsAt, organizer: "DACON", location: "온라인", participationMode: "온라인",
      posterUrl: card.poster ? absoluteUrl(base, card.poster) : undefined, genres: normalizeGenres(undefined, `AI ${card.title} ${summary ?? ""}`), region: "kr",
    } satisfies EventItem;
  }), DETAIL_CONCURRENCY);
  return details.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

async function fetchGongil(): Promise<EventItem[]> {
  const base = "https://www.gongil.co.kr/";
  const $ = load(await fetchText(base));
  const candidates = new Map<string, string>();
  $('a[href^="/contests/"]').each((_, node) => {
    const anchor = $(node);
    const text = anchor.text().replace(/\s+/g, " ").trim();
    if (!text.startsWith("국내 ") || !/AI\/데이터|인공지능|AI\s|해커톤|정보보호|정보보안|사이버보안|해킹방어|CTF/i.test(text)) return;
    const url = absoluteUrl(base, anchor.attr("href") ?? "");
    if (url) candidates.set(url, text);
  });
  const details = await settleInBatches([...candidates].slice(0, 12).map(([url, cardText]) => async () => {
    const detail = load(await fetchText(url));
    const title = detail("title").first().text().split("|", 1)[0].trim();
    const text = detail.root().text().replace(/\s+/g, " ");
    const deadlineParts = /마감일\s*(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(text);
    if (!title || !deadlineParts) return undefined;
    const official = detail("a[href]").toArray().find((node) => detail(node).text().includes("지원하기") && /^https?:/i.test(detail(node).attr("href") ?? ""));
    const link = official ? detail(official).attr("href") ?? url : url;
    const host = new URL(link).hostname.replace(/^www\./, "");
    if (["dacon.io", "aichallenge4all.or.kr", "maicon.kr", "kcf.or.kr", "ctftime.org"].includes(host)) return undefined;
    const deadline = Date.UTC(Number(deadlineParts[1]), Number(deadlineParts[2]) - 1, Number(deadlineParts[3]), 14, 59);
    const kind: EventKind = /해커톤|hackathon/i.test(title) ? "hackathon" : /CTF|해킹방어/i.test(title) ? "ctf" : /AI|인공지능|데이터/i.test(title) ? "ai" : "security";
    return {
      id: sha256(url), guildId: "", title, link, source: "공일", kind, summary: cardText.slice(0, 500),
      registrationDeadline: deadline, publishedAt: deadline, participationMode: participationMode(text),
      genres: normalizeGenres(undefined, `${title} ${cardText}`), region: "kr",
    } satisfies EventItem;
  }), DETAIL_CONCURRENCY);
  return details.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

async function fetchKiisc(): Promise<EventItem[]> {
  const base = "https://www.kiisc.or.kr/";
  const $ = load(await fetchText(base));
  const events = new Map<string, EventItem>();
  $('a[href*="/bbs/pe/article/"]').each((_, node) => {
    const anchor = $(node);
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const rawDate = anchor.closest("tr").find(".noticesecond").first().text().trim();
    const startsAt = parseDate(rawDate) ?? extractDateTimes(rawDate)[0];
    const link = absoluteUrl(base, anchor.attr("href") ?? "");
    if (!title || !startsAt || !link) return;
    events.set(link, {
      id: sha256(link), guildId: "", title, link, source: "한국정보보호학회", kind: "conference",
      startsAt, endsAt: startsAt, publishedAt: startsAt, organizer: "한국정보보호학회", location: "대한민국",
      participationMode: "오프라인", region: "kr",
    });
  });
  $(".tl-card3").each((_, node) => {
    const card = $(node);
    const title = card.find(".banner_link").first().text().replace(/\s+/g, " ").trim();
    const rawDate = card.find(".banner_date").first().text().trim();
    const dates = extractDateTimes(rawDate);
    const link = absoluteUrl(base, card.find("a[href]").first().attr("href") ?? "");
    if (!title || !dates.length || !link) return;
    events.set(link, {
      id: sha256(link), guildId: "", title, link, source: "한국정보보호학회", kind: "conference",
      startsAt: dates[0], endsAt: dates[1] ?? dates[0], publishedAt: dates[0], organizer: "한국정보보호학회",
      location: card.find(".banner_venue").first().text().trim() || "대한민국", participationMode: "오프라인", region: "kr",
    });
  });
  return [...events.values()];
}

function walkObjects(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return value.flatMap(walkObjects);
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, any>;
  return [row, ...Object.values(row).flatMap(walkObjects)];
}

async function fetchJsonLd(name: string, url: string, kind: EventKind): Promise<EventItem[]> {
  const $ = load(await fetchText(url));
  const events: EventItem[] = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    try {
      for (const row of walkObjects(JSON.parse($(node).text()))) {
        if (row["@type"] !== "Event" || !row.name) continue;
        const link = String(row.url ?? url);
        const location = typeof row.location === "object" ? row.location?.name : row.location;
        const startsAt = parseDate(row.startDate);
        events.push({
          id: sha256(`${name}|${row.name}|${row.startDate ?? ""}|${link}`), guildId: "", title: String(row.name), link, source: name, kind,
          summary: row.description ? stripHtml(String(row.description)) : undefined, startsAt, endsAt: parseDate(row.endDate),
          registrationDeadline: parseDate(row.registrationDeadline), publishedAt: startsAt ?? Date.now(),
          posterUrl: typeof row.image === "string" ? row.image : Array.isArray(row.image) ? row.image[0] : row.image?.url,
          organizer: typeof row.organizer === "object" ? row.organizer?.name : row.organizer,
          location: location ? String(location) : undefined, participationMode: participationMode(row.eventAttendanceMode, location, row.description),
          genres: normalizeGenres(row.keywords, String(row.description ?? "")), region: ["conference", "hackathon"].includes(kind) ? "kr" : undefined,
        });
      }
    } catch {
      // 잘못된 JSON-LD 블록 하나 때문에 다른 블록까지 버리지 않는다.
    }
  });
  return events;
}

async function fetchKoreanCodeFair(): Promise<EventItem[]> {
  const pages: Array<[string, string, EventKind]> = [
    ["https://kcf.or.kr/88", "한국코드페어 SW공모전", "security"],
    ["https://kcf.or.kr/78", "한국코드페어 해커톤", "hackathon"],
  ];
  const results: EventItem[] = [];
  for (const [url, fallback, kind] of pages) {
    const $ = load(await fetchText(url));
    const text = $.root().text().replace(/\s+/g, " ");
    const registration = periodAfterLabel(text, /접수\s*기간|접수기간|모집/i).slice(0, 2);
    if (!registration.length) continue;
    const edition = /제\s*(\d+)\s*회\s*한국코드페어/.exec(text)?.[1];
    const title = `${edition ? `제${edition}회 ` : ""}한국코드페어 ${kind === "hackathon" ? "해커톤" : "SW공모전"}`;
    results.push({
      id: sha256(`${fallback}|${new Date(registration[0]).getUTCFullYear()}|${url}`), guildId: "", title, link: url, source: "한국코드페어", kind,
      summary: fallback, registration: formatPeriod(registration), registrationDeadline: registration.at(-1), publishedAt: registration[0],
      organizer: "과학기술정보통신부 / 한국지능정보사회진흥원", eligibility: "대한민국 청소년(고등학생 참가 가능)",
      teamLimit: "개인 또는 3인 이하 팀", participationMode: participationMode(text), genres: normalizeGenres(undefined, text), region: "kr",
    });
  }
  return results;
}

async function fetchOfficialBoard(board: (typeof OFFICIAL_BOARDS)[number]): Promise<EventItem[]> {
  const $ = load(await fetchText(board.url));
  const candidates = new Map<string, string>();
  $("a[href]").each((_, node) => {
    if (candidates.size >= 12) return;
    const anchor = $(node);
    const title = anchor.text().replace(/\s+/g, " ").trim();
    const link = absoluteUrl(board.url, anchor.attr("href") ?? "");
    if (title && link && board.titlePattern.test(title) && board.linkPattern.test(link)) candidates.set(link, title);
  });
  const details = await settleInBatches([...candidates].map(([url, title]) => async () => {
    const notice = await fetchNoticeText(url);
    if (board.audiencePattern && !board.audiencePattern.test(`${title}\n${notice}`)) return undefined;
    let event: EventItem;
    try {
      event = parseEventNotice(`${title}\n${notice}`, board.name);
    } catch {
      event = { id: sha256(url), guildId: "", title, link: url, source: board.name, kind: board.kind, publishedAt: Date.now() };
    }
    event.id = sha256(url);
    event.title = title.slice(0, 200);
    event.link = url;
    event.registrationUrl = url;
    event.kind = board.kind;
    event.manual = false;
    if (board.kind === "news") {
      event.startsAt = extractDateTimes(notice)[0];
      event.publishedAt = event.startsAt ?? event.publishedAt;
      event.endsAt = undefined;
      event.registration = undefined;
      event.registrationDeadline = undefined;
    } else if (!event.registrationDeadline && !event.startsAt) return undefined;
    return event;
  }), DETAIL_CONCURRENCY);
  return details.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

async function fetchGenericPage(url: string): Promise<EventItem[]> {
  const html = await fetchText(url);
  const $ = load(html);
  const source = new URL(url).hostname;
  const candidates = new Map<string, string>();
  $("a[href]").slice(0, 400).each((_, node) => {
    const anchor = $(node);
    const title = anchor.text().replace(/\s+/g, " ").replace(/\[[^\]]*]/g, "").trim();
    const link = absoluteUrl(url, anchor.attr("href") ?? "");
    if (link && title.length >= 4 && title.length <= 180 && SECURITY_RE.test(title) && isEventAnnouncement(title)) candidates.set(link, title);
  });
  const events = await settleInBatches([...candidates].slice(0, 12).map(([link, title]) => async () => {
    const notice = await fetchNoticeText(link);
    if (looksLikeResultNews(title, notice)) return undefined;
    const event = parseEventNotice(`${title}\n${notice}`, source);
    event.id = sha256(link);
    event.link = link;
    event.registrationUrl ||= link;
    event.manual = false;
    return event;
  }), DETAIL_CONCURRENCY);
  return events.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

async function naverSearch(options: CollectorOptions, query: SearchQuery, target: "webkr" | "news"): Promise<SearchResult[]> {
  if (!options.naverClientId || !options.naverClientSecret) return [];
  const url = new URL(`https://openapi.naver.com/v1/search/${target}.json`);
  url.search = new URLSearchParams({ query: query.query, display: String(Math.min(options.searchApiMaxResults, 100)), start: "1", sort: target === "news" ? "date" : "sim" }).toString();
  const payload: any = await fetchJson(url, { headers: { "X-Naver-Client-Id": options.naverClientId, "X-Naver-Client-Secret": options.naverClientSecret } });
  return list(payload?.items).flatMap((row: any) => {
    const title = stripHtml(String(row?.title ?? ""));
    const link = String(row?.originallink || row?.link || "");
    return title && link ? [{ provider: `NaverSearch-${target}`, title, url: link, snippet: stripHtml(String(row?.description ?? "")), publishedAt: parseDate(row?.pubDate) }] : [];
  });
}

async function googleSearch(options: CollectorOptions, query: SearchQuery): Promise<SearchResult[]> {
  if (!options.googleApiKey || !options.googleCseId) return [];
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.search = new URLSearchParams({ key: options.googleApiKey, cx: options.googleCseId, q: query.query, num: String(Math.min(options.searchApiMaxResults, 10)), lr: "lang_ko", dateRestrict: "m1" }).toString();
  const payload: any = await fetchJson(url);
  return list(payload?.items).flatMap((row: any) => row?.title && row?.link ? [{ provider: "GoogleCustomSearch", title: stripHtml(String(row.title)), url: String(row.link), snippet: stripHtml(String(row.snippet ?? "")) }] : []);
}

async function bingSearch(options: CollectorOptions, query: SearchQuery): Promise<SearchResult[]> {
  if (!options.bingApiKey) return [];
  const url = new URL(options.bingEndpoint.replace(/\/$/, ""));
  url.search = new URLSearchParams({ q: query.query, count: String(Math.min(options.searchApiMaxResults, 50)), mkt: "ko-KR", setLang: "ko", freshness: "Month", responseFilter: "Webpages" }).toString();
  const payload: any = await fetchJson(url, { headers: { "Ocp-Apim-Subscription-Key": options.bingApiKey } });
  return list(payload?.webPages?.value).flatMap((row: any) => row?.name && row?.url ? [{ provider: "BingWebSearch", title: stripHtml(String(row.name)), url: String(row.url), snippet: stripHtml(String(row.snippet ?? "")), publishedAt: parseDate(row.dateLastCrawled) }] : []);
}

async function searchResultToEvent(result: SearchResult, query: SearchQuery, lookaheadDays: number): Promise<EventItem | undefined> {
  const combined = `${result.title}\n${result.snippet}\n${result.url}`;
  if (!result.title || !result.url || BLOCKED_URL_RE.test(result.url) || !SECURITY_RE.test(combined)) return undefined;
  if (query.kind === "news") {
    if (!isSecurityNews(result.title, result.snippet) || (result.publishedAt && result.publishedAt < Date.now() - 30 * 86_400_000)) return undefined;
    return { id: sha256(`${result.provider}|${result.url}`), guildId: "", title: result.title, link: result.url, source: query.name, kind: "news", summary: result.snippet.slice(0, 500), publishedAt: result.publishedAt ?? Date.now(), startsAt: result.publishedAt ?? Date.now() };
  }
  if (isEditorialUrl(result.url)) return undefined;
  if (!searchTitleMatchesKind(query.kind, result.title)) return undefined;
  if (!isEventAnnouncement(result.title, result.snippet) || looksLikeResultNews(result.title, result.snippet)) return undefined;
  let notice = combined;
  try {
    const loaded = await fetchNoticeText(result.url);
    if (loaded.length > notice.length) notice = `${result.title}\n${loaded}\n${result.url}`;
  } catch {
    // 검색 요약으로 계속 시도한다.
  }
  let event: EventItem;
  try {
    event = parseEventNotice(notice, query.name);
  } catch {
    return undefined;
  }
  event.id = sha256(`${result.provider}|${result.url}`);
  event.kind = query.kind;
  event.link ||= result.url;
  event.registrationUrl ||= event.link;
  event.summary ||= result.snippet.slice(0, 500);
  event.manual = false;
  if (!titleYearMatchesEvent(result.title, event)) return undefined;
  if (query.kind === "hackathon" && !isKoreanCandidate(notice, result.url)) return undefined;
  const target = event.registrationDeadline ?? event.startsAt;
  if (query.requireDate && !target) return undefined;
  if (target && (target < Date.now() - 3 * 86_400_000 || target > Date.now() + lookaheadDays * 86_400_000)) return undefined;
  return event;
}

async function fetchSearchApi(options: CollectorOptions): Promise<EventItem[]> {
  const tasks = SEARCH_QUERIES.flatMap((query) => {
    const providers = [
      () => naverSearch(options, query, "webkr").then((rows) => [query, rows] as const),
      () => googleSearch(options, query).then((rows) => [query, rows] as const),
      () => bingSearch(options, query).then((rows) => [query, rows] as const),
    ];
    if (query.kind === "news") providers.push(
      () => naverSearch(options, query, "news").then((rows) => [query, rows] as const),
    );
    return providers;
  });
  const searched = await settleInBatches(tasks, options.sourceConcurrency);
  const conversions: Array<() => Promise<EventItem | undefined>> = [];
  for (const result of searched) {
    if (result.status !== "fulfilled") continue;
    const [query, rows] = result.value;
    for (const row of rows) conversions.push(() => searchResultToEvent(row, query, options.lookaheadDays));
  }
  const converted = await settleInBatches(conversions, DETAIL_CONCURRENCY);
  const seen = new Set<string>();
  return converted.flatMap((result) => {
    if (result.status !== "fulfilled" || !result.value) return [];
    const key = result.value.link.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    if (key && seen.has(key)) return [];
    if (key) seen.add(key);
    return [result.value];
  });
}

export function optionsFromEnv(): CollectorOptions {
  const csv = (name: string) => (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const bool = (name: string, fallback: boolean) => process.env[name] == null ? fallback : /^(?:1|true|yes|on)$/i.test(process.env[name] ?? "");
  return {
    lookaheadDays: Math.max(1, Number(process.env.LOOKAHEAD_DAYS ?? 365) || 365),
    enableKctf: bool("ENABLE_KCTF", false),
    enableAutoDiscovery: bool("ENABLE_AUTO_DISCOVERY", true),
    discoveryFeedUrls: csv("DISCOVERY_FEED_URLS"),
    extraFeedUrls: csv("EXTRA_FEED_URLS"),
    eventPageUrls: csv("EVENT_PAGE_URLS"),
    enableSearchApiDiscovery: bool("ENABLE_SEARCH_API_DISCOVERY", true),
    searchApiMaxResults: Math.max(1, Number(process.env.SEARCH_API_MAX_RESULTS ?? 5) || 5),
    naverClientId: process.env.NAVER_CLIENT_ID || undefined,
    naverClientSecret: process.env.NAVER_CLIENT_SECRET || undefined,
    googleApiKey: process.env.GOOGLE_API_KEY || undefined,
    googleCseId: process.env.GOOGLE_CSE_ID || undefined,
    bingApiKey: process.env.BING_API_KEY || undefined,
    bingEndpoint: process.env.BING_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search",
    sourceTimeoutMs: Math.max(5_000, Number(process.env.SOURCE_TIMEOUT_MS ?? 20_000) || 20_000),
    sourceConcurrency: Math.max(1, Number(process.env.SOURCE_CONCURRENCY ?? 2) || 2),
  };
}

export async function collectEventItems(options = optionsFromEnv()): Promise<CollectionResult> {
  REQUEST_TIMEOUT_MS = options.sourceTimeoutMs ?? 20_000;
  DETAIL_CONCURRENCY = options.sourceConcurrency;
  const sources: Array<{ name: string; fetch: () => Promise<EventItem[]> }> = [
    { name: "CTFtime", fetch: () => fetchCtftime(options.lookaheadDays) },
    { name: "DACON", fetch: fetchDacon },
    { name: "공일", fetch: fetchGongil },
    { name: "전국민 AI 경진대회", fetch: () => fetchJsonLd("전국민 AI 경진대회", "https://aichallenge4all.or.kr/", "ai") },
    { name: "국방 AI 경진대회", fetch: () => fetchJsonLd("국방 AI 경진대회", "https://maicon.kr/", "ai") },
    { name: "국방 정보화 컨퍼런스", fetch: () => fetchJsonLd("국방 정보화 컨퍼런스", "https://www.mnd-ict.com/", "conference") },
    { name: "CODEGATE", fetch: () => fetchJsonLd("CODEGATE", "https://codegate.org/", "conference") },
    { name: "SECON", fetch: () => fetchJsonLd("SECON", "https://www.seconexpo.com/", "conference") },
    { name: "한국코드페어", fetch: fetchKoreanCodeFair },
    { name: "한국정보보호학회", fetch: fetchKiisc },
    { name: "보안뉴스", fetch: fetchBoanNews },
    ...OFFICIAL_BOARDS.map((board) => ({ name: board.name, fetch: () => fetchOfficialBoard(board) })),
    ...options.extraFeedUrls.map((url) => ({ name: new URL(url).hostname, fetch: () => fetchJsonFeed(url) })),
    ...options.eventPageUrls.map((url) => ({ name: new URL(url).hostname, fetch: () => fetchGenericPage(url) })),
  ];
  if (options.enableKctf) sources.push({ name: "K-CTF", fetch: fetchKctf });
  if (options.enableAutoDiscovery) {
    const feeds = options.discoveryFeedUrls.length
      ? options.discoveryFeedUrls.map((url, index) => ({ name: `사용자자동탐색-${index + 1}`, url, kind: "security" as EventKind, max: 8 }))
      : DEFAULT_DISCOVERY_FEEDS;
    sources.push(...feeds.map((feed) => ({ name: feed.name, fetch: () => fetchDiscoveryFeed(feed, options.lookaheadDays) })));
  }
  if (options.enableSearchApiDiscovery && (options.naverClientId || options.googleApiKey || options.bingApiKey)) {
    sources.push({ name: "검색API자동탐색", fetch: () => fetchSearchApi(options) });
  }

  const results = await settleInBatches(
    sources.map((source) => source.fetch),
    options.sourceConcurrency,
  );
  const items: EventItem[] = [];
  const errors: string[] = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === "fulfilled") items.push(...result.value);
    else errors.push(`${sources[index].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  }
  return { items, errors };
}
