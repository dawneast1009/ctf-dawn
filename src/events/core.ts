import { createHash } from "node:crypto";
import type { EventItem } from "../store";

export type EventKind = "ctf" | "ai" | "conference" | "hackathon" | "security" | "news";
export type EventBucket = "within_1m" | "within_2m" | "later" | "final" | "ended" | "unknown" | "latest";

const DAY = 86_400_000;
const KST_OFFSET = 9 * 60 * 60 * 1000;

const GENRE_PATTERNS: Record<string, RegExp> = {
  Web: /\bweb\b|웹|xss|sql injection|ssrf|csrf/i,
  Pwn: /\bpwn(?:able)?\b|포너블|시스템 ?해킹|binary exploitation|heap|buffer overflow/i,
  Reversing: /\brev(?:ersing)?\b|리버싱|reverse engineering|malware/i,
  Crypto: /\bcrypto(?:graphy)?\b|암호|rsa|elliptic curve/i,
  Forensics: /\bforensic(?:s)?\b|포렌식|disk image|memory analysis/i,
  Misc: /\bmisc(?:ellaneous)?\b|기타|steganography|스테가노/i,
  OSINT: /\bosint\b|open.?source intelligence|공개출처정보|오신트/i,
  "Attack-Defense": /attack.?defen[cs]e|공방전|red team.*blue team/i,
  AI: /\bai\b|artificial intelligence|인공지능|machine learning|머신러닝|딥러닝/i,
};

const RESULT_NEWS_RE = /수상|입상|최우수상|우수상|장려상|성과|성료|마무리|개최\s*(?:결과|성과)|시상식|차지|선정|대상\s*(?:수상|차지)|(?:수상|시상).*대상/i;
const SECURITY_NEWS_RE = /취약점|침해사고|랜섬웨어|악성코드|보안패치|제로데이|CVE|해킹|개인정보|유출|사이버공격|보안뉴스|위협/i;
const EVENT_RE = /대회|경진대회|해커톤|컨퍼런스|세미나|포럼|교육|캠프|공모전|모집|접수|참가|신청|개최|일정|안내|예선|본선|결승|CTF|challenge|competition|conference|hackathon/i;
const KOREAN_LOCATION_RE = /대한민국|(?<![가-힣])한국(?!어|인|계|학|형|화)|\bsouth korea\b|\brepublic of korea\b|전국\s*(?:고등학생|고교생|청소년|대학생)|서울|부산|대전|인천|광주|대구|울산|제주|세종|수원|판교|나주|전남|전북|경남|경북|충남|충북|강원|경기|코엑스|\bcoex\b/i;
const FOREIGN_LOCATION_RE = /\b(?:united states|usa|canada|mexico|brazil|argentina|united kingdom|england|france|germany|spain|italy|netherlands|switzerland|sweden|norway|finland|poland|romania|russia|ukraine|turkey|israel|india|pakistan|bangladesh|china|japan|singapore|taiwan|thailand|vietnam|indonesia|malaysia|philippines|australia|new zealand|uae|dubai|tokyo|osaka|beijing|shanghai|hong kong|london|paris|berlin|amsterdam|zurich|moscow|new york|las vegas|san francisco)\b|미국|캐나다|멕시코|브라질|아르헨티나|영국|프랑스|독일|스페인|이탈리아|네덜란드|스위스|스웨덴|노르웨이|핀란드|폴란드|루마니아|러시아|우크라이나|튀르키예|터키|이스라엘|인도|파키스탄|방글라데시|중국|일본|싱가포르|대만|태국|베트남|인도네시아|말레이시아|필리핀|호주|뉴질랜드|아랍에미리트|두바이|도쿄|오사카|베이징|상하이|홍콩|런던|파리|베를린|암스테르담|취리히|모스크바|뉴욕|라스베이거스|샌프란시스코/i;

export const EVENT_KIND_ORDER: EventKind[] = ["ctf", "ai", "conference", "hackathon", "security", "news"];

export function sha256(value: string, length = 20): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function compactText(value: string, limit = 12_000): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, limit);
}

export function stripHtml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeGenres(raw: unknown, text = ""): string[] {
  const values: string[] = [];
  if (typeof raw === "string") values.push(...raw.split(/[,/|]/));
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        values.push(String(row.name ?? row.title ?? ""));
      } else values.push(String(item ?? ""));
    }
  }
  const searchable = [...values, text].join(" ");
  const genres = Object.entries(GENRE_PATTERNS)
    .filter(([, pattern]) => pattern.test(searchable))
    .map(([genre]) => genre);
  return [...new Set(genres.length ? genres : ["General"])];
}

export function participationMode(...values: unknown[]): string {
  const text = values.map((value) => String(value ?? "")).join(" ");
  const online = /\bonline\b|온라인|remote|virtual|비대면/i.test(text);
  const offline = /\boffline\b|오프라인|onsite|on-site|현장|대면|서울|부산|대전|인천|광주|대구|제주|코엑스|coex|대학교|센터/i.test(text);
  if (online && offline) return "온·오프라인 병행";
  if (online) return "온라인";
  if (offline) return "오프라인";
  return "정보 없음";
}

export function parseDate(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(String(value).trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function kstTimestamp(year: number, month: number, day: number, hour = 0, minute = 0): number | undefined {
  const result = Date.UTC(year, month - 1, day, hour, minute) - KST_OFFSET;
  const check = new Date(result + KST_OFFSET);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return result;
}

const FULL_DATE_RE = /(?<year>20\d{2})\s*(?:년|[./-])\s*(?<month>\d{1,2})\s*(?:월|[./-])\s*(?<day>\d{1,2})\s*일?(?:\s*(?:\([^)]+\))?\s*(?<hour>\d{1,2})(?:\s*:\s*(?<minute>\d{2}))?\s*(?:시|분)?\s*(?<ampm>AM|PM|오전|오후)?)?/gi;
const SHORT_DATE_RE = /(?<!\d)(?<month>\d{1,2})\s*(?:월|[./])\s*(?<day>\d{1,2})\s*일?(?:\s*(?:\([^)]+\))?\s*(?<hour>\d{1,2})(?:\s*:\s*(?<minute>\d{2}))?\s*(?:시|분)?\s*(?<ampm>AM|PM|오전|오후)?)?/gi;

function dateFromGroups(groups: Record<string, string | undefined>, fallbackYear?: number): number | undefined {
  let hour = Number(groups.hour ?? 0);
  const minute = Number(groups.minute ?? 0);
  const ampm = (groups.ampm ?? "").toLowerCase();
  if ((ampm === "pm" || ampm === "오후") && hour < 12) hour += 12;
  if ((ampm === "am" || ampm === "오전") && hour === 12) hour = 0;
  return kstTimestamp(Number(groups.year ?? fallbackYear), Number(groups.month), Number(groups.day), hour, minute);
}

export function extractDateTimes(text: string): number[] {
  const values: number[] = [];
  const occupied: Array<[number, number]> = [];
  let inferredYear = new Date(Date.now() + KST_OFFSET).getUTCFullYear();
  for (const match of text.matchAll(FULL_DATE_RE)) {
    if (!match.groups) continue;
    const value = dateFromGroups(match.groups);
    if (value != null) {
      values.push(value);
      inferredYear = Number(match.groups.year);
      occupied.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of text.matchAll(SHORT_DATE_RE)) {
    if (!match.groups) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (occupied.some(([a, b]) => !(end <= a || b <= start))) continue;
    const value = dateFromGroups(match.groups, inferredYear);
    if (value != null) values.push(value);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

export function periodAfterLabel(text: string, label: RegExp): number[] {
  const flags = label.flags.replace("g", "");
  const match = new RegExp(label.source, flags).exec(text);
  if (!match) return [];
  return extractDateTimes(text.slice(match.index + match[0].length, match.index + match[0].length + 240));
}

export function looksLikeResultNews(title: string, summary = ""): boolean {
  return RESULT_NEWS_RE.test(`${title} ${summary}`);
}

export function isSecurityNews(title: string, summary = ""): boolean {
  return SECURITY_NEWS_RE.test(`${title} ${summary}`);
}

export function isEventAnnouncement(title: string, summary = ""): boolean {
  return EVENT_RE.test(`${title} ${summary}`);
}

export function classifyEvent(title: string, summary = ""): EventKind {
  const titleOnly = title.toLowerCase();
  const text = `${title} ${summary}`;
  // 본문의 "참가 대상" 같은 필드가 수상 기사로 오인되지 않도록 결과 판정은 제목 위주로 한다.
  if (looksLikeResultNews(title)) return "news";
  if (/해커톤|hackathon|아이디어톤|ideathon/i.test(text)) return "hackathon";
  if (/컨퍼런스|conference|세미나|포럼\b|forum\b|secon/i.test(text)) return "conference";
  if (/(?:인공지능|(?:^|\W)AI(?:\W|$)|머신러닝|딥러닝|데이터\s*분석|dacon|데이콘)/i.test(text) && /경진|대회|공모전|competition|challenge/i.test(text)) return "ai";
  if (/\bCTF\b|capture\s+the\s+flag|해킹\s*방어\s*대회|사이버\s*(?:공격\s*)?방어\s*대회|ctftime|wacon/i.test(titleOnly)) return "ctf";
  if (/정보보안|정보보호|사이버보안|화이트햇|해킹|보안/i.test(text) && /영재(?:원|교육원)?|교육생|수강생|아카데미|부트캠프|교육\s*(?:과정|프로그램)|캠프|멘토링|연수생|훈련생|공모전|진로\s*체험|특강|워크숍|장학생|동아리|모집/i.test(text)) return "security";
  if (isSecurityNews(title, summary)) return "news";
  return "security";
}

function cleanLine(line: string): string {
  return line.replace(/^[\s>*#\-•·▪◦✅☑️📌📍🗓️📅⏰🔗]+/u, "").trim();
}

function valueAfterLabel(line: string): string {
  const separator = /\s*[:：]\s*|\s+-\s+/.exec(line);
  return separator ? line.slice(separator.index + separator[0].length).trim() : line.trim();
}

function labeledValue(lines: string[], labels: RegExp): string | undefined {
  for (const line of lines) {
    if (!labels.test(line)) continue;
    labels.lastIndex = 0;
    const value = valueAfterLabel(line);
    if (value !== line || line.length <= 120) return value;
  }
  return undefined;
}

function noticeName(lines: string[]): string {
  const labeled = labeledValue(lines, /^(?:행사명|대회명|프로그램명|공모전명|교육명|컨퍼런스명|해커톤명|제목|title)\b/i);
  if (labeled) return labeled;
  for (const line of lines) {
    const candidate = line.replace(/^\[(?:공지|대회|행사|컨퍼런스|해커톤|CTF)\]\s*/i, "").replace(/[*_`]/g, "").trim();
    if (candidate && !/^https?:\/\//i.test(candidate) && !FULL_DATE_RE.test(candidate) && candidate.length <= 200) {
      FULL_DATE_RE.lastIndex = 0;
      return candidate;
    }
    FULL_DATE_RE.lastIndex = 0;
  }
  throw new Error("행사명을 찾지 못했습니다. 첫 줄에 행사명을 넣어주세요.");
}

export function parseEventNotice(content: string, source = "Direct"): EventItem {
  const lines = content.split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (!lines.length) throw new Error("공지 내용이 비어 있습니다.");
  const title = noticeName(lines);
  const kind = classifyEvent(title, content);
  const middleSchoolOnly = /중학생|중학교/.test(content) && !/고등학생|고교생|고등학교|청소년/.test(content);
  const primaryType = /\bCTF\b|capture\s+the\s+flag|해킹\s*방어\s*대회|해커톤|hackathon|컨퍼런스|conference|세미나|포럼\b|(?:인공지능|(?:^|\W)AI(?:\W|$)|머신러닝|딥러닝).{0,20}(?:경진|대회|competition|challenge)/i.test(content);
  if (middleSchoolOnly && !primaryType) throw new Error("중학생 전용 기타 공지는 수집 대상이 아닙니다.");

  const links = [...content.matchAll(/https?:\/\/[^\s<>]+/gi)].map((match) => match[0].replace(/[.,);\]}>]+$/, ""));
  const link = links[0] ?? "";
  const registration = labeledValue(lines, /^(?:모집|신청|접수|등록|사전\s*등록)(?:\s*(?:기간|일정|마감|기한))?/i);
  const schedule = labeledValue(lines, /^(?:대회|행사|본선|예선|개최|교육|강의|컨퍼런스|해커톤|운영)?\s*(?:일시|일정|기간)/i);
  const registrationDates = extractDateTimes(registration ?? "");
  let scheduleDates = extractDateTimes(schedule ?? "");
  if (!scheduleDates.length) {
    scheduleDates = extractDateTimes(lines.filter((line) => line !== registration && /20\d{2}\s*(?:년|[./-])/.test(line)).join(" "));
  }
  const allDates = extractDateTimes(content);
  let registrationDeadline = registrationDates.at(-1);
  let startsAt = scheduleDates[0];
  let endsAt = scheduleDates.length > 1 ? scheduleDates.at(-1) : undefined;
  if (!registrationDeadline) {
    const deadlineLines = lines.filter((line) => /마감|접수|신청|모집|등록/i.test(line));
    registrationDeadline = extractDateTimes(deadlineLines.join(" ")).at(-1);
  }
  if (!startsAt) {
    const eventLines = lines.filter((line) => /일정|일시|개최|진행|운영|대회|행사|교육|본선|예선/i.test(line) && line !== registration);
    const eventDates = extractDateTimes(eventLines.join(" "));
    startsAt = eventDates[0];
    endsAt ??= eventDates.length > 1 ? eventDates.at(-1) : undefined;
  }
  if (!registrationDeadline && !startsAt && allDates.length) {
    startsAt = allDates[0];
    endsAt = allDates.length > 1 ? allDates.at(-1) : undefined;
  }

  const organizer = labeledValue(lines, /^(?:주최|주관|주최\s*\/\s*주관|운영)/i);
  const eligibility = labeledValue(lines, /^(?:참가\s*대상|참가\s*자격|대상)/i);
  const location = labeledValue(lines, /^(?:장소|위치|개최\s*장소|진행\s*장소)/i);
  const mode = labeledValue(lines, /^(?:진행\s*방식|참여\s*방식|운영\s*방식|형태)/i);
  const teamLimit = labeledValue(lines, /^(?:팀\s*(?:구성|인원|제한)|참가\s*인원|인원\s*제한|모집\s*인원)/i);
  return {
    id: sha256(`${source}|${title}|${startsAt ?? ""}|${link}`),
    guildId: "",
    title,
    link,
    source,
    kind,
    summary: lines.join(" ").slice(0, 500),
    organizer,
    eligibility,
    registration,
    registrationUrl: link || undefined,
    registrationDeadline,
    genres: normalizeGenres(undefined, content),
    teamLimit,
    participationMode: mode ?? participationMode(content, location),
    location,
    publishedAt: startsAt ?? registrationDeadline ?? Date.now(),
    startsAt,
    endsAt,
    manual: source === "Manual" || source === "Direct" || source === "HSPACE",
  };
}

export function normalizedEventTitle(title: string): string {
  return title
    .replace(/\[[^\]]+]/g, " ")
    .replace(/\([^)]*(?:종합|속보|단독|포토|영상|그래픽|보도자료)[^)]*\)/g, " ")
    .replace(/["'“”‘’]/g, "")
    .replace(/\s*[-|:]\s*(?:보안뉴스|데일리시큐|전자신문|아이뉴스24|ZDNET Korea|지디넷코리아|연합뉴스|뉴스1|뉴시스|매일경제|한국경제|이데일리|파이낸셜뉴스).*$/i, "")
    .replace(/[^a-z0-9가-힣]+/gi, "")
    .toLowerCase();
}

export function eventDedupeKey(item: EventItem): string {
  const date = item.startsAt ? new Date(item.startsAt + KST_OFFSET).toISOString().slice(0, 10) : "";
  return `${item.kind ?? "security"}:${normalizedEventTitle(item.title)}:${date}`;
}

export function eventContentHash(item: EventItem): string {
  const normalized = {
    title: item.title,
    link: item.link,
    source: item.source,
    kind: item.kind,
    summary: item.summary,
    organizer: item.organizer,
    eligibility: item.eligibility,
    registration: item.registration,
    registrationUrl: item.registrationUrl,
    registrationDeadline: item.registrationDeadline,
    genres: item.genres,
    teamLimit: item.teamLimit,
    participationMode: item.participationMode,
    location: item.location,
    posterUrl: item.posterUrl,
    region: item.region,
    publishedAt: item.publishedAt,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function eventRegion(item: EventItem): "kr" | "global" {
  if (item.region === "kr" || item.region === "global") return item.region;
  if (["K-CTF", "한국코드페어", "CODEGATE 해커톤"].includes(item.source)) return "kr";
  if (item.location) {
    if (KOREAN_LOCATION_RE.test(item.location)) return "kr";
    if (FOREIGN_LOCATION_RE.test(item.location)) return "global";
  }
  const context = [item.title, item.eligibility, item.summary].filter(Boolean).join(" ");
  const korean = KOREAN_LOCATION_RE.test(context);
  const foreign = FOREIGN_LOCATION_RE.test(context);
  if (foreign && !korean) return "global";
  if (korean && !foreign) return "kr";
  if (item.source === "검색API-CTF-해외") return "global";
  try {
    const host = new URL(item.link || item.registrationUrl || "https://invalid.local").hostname;
    if (/\.(?:kr|ac\.kr|go\.kr|or\.kr|re\.kr)$/.test(host)) return "kr";
  } catch {
    // 링크가 없는 수동 행사는 텍스트만으로 판정한다.
  }
  return "global";
}

export function bucketForEvent(item: Pick<EventItem, "kind" | "title" | "registrationDeadline" | "startsAt" | "endsAt">, now = Date.now()): EventBucket {
  if (item.kind === "news") return "latest";
  if (item.endsAt && item.endsAt < now) return "ended";
  if (!["conference", "security"].includes(item.kind ?? "") && /\bmain round\b|\bmain stage\b|\bfinals?\b|\bgrand final\b|본선|결승|데모 ?데이|demo ?day/i.test(item.title)) return "final";
  const target = item.registrationDeadline ?? item.startsAt;
  if (!target) return "later";
  if (target <= now + 30 * DAY) return "within_1m";
  if (target <= now + 60 * DAY) return "within_2m";
  return "later";
}

export function eventDateLabel(item: EventItem): string {
  const target = item.registrationDeadline ?? item.startsAt ?? item.endsAt;
  return target ? new Date(target + KST_OFFSET).toISOString().slice(0, 10) : "날짜 미정";
}

export function shouldIncludeEvent(item: EventItem, options: { now?: number; lookaheadDays: number; tracked: boolean }): boolean {
  const now = options.now ?? Date.now();
  const cutoff = now + options.lookaheadDays * DAY;
  if (item.kind === "news") {
    const published = item.startsAt ?? item.publishedAt;
    return published >= now - 30 * DAY && published <= now + DAY && isSecurityNews(item.title, item.summary ?? "");
  }
  if (item.endsAt && item.endsAt < now) return options.tracked;
  if (item.startsAt && item.endsAt && item.startsAt < now && now <= item.endsAt) return true;
  const target = item.registrationDeadline ?? item.startsAt;
  if (!target && item.manual) return true;
  return Boolean(target && target >= now - 12 * 60 * 60 * 1000 && target <= cutoff);
}

export function interleaveEvents(events: EventItem[]): EventItem[] {
  const dateKey = (event: EventItem) => event.registrationDeadline ?? event.startsAt ?? event.endsAt ?? Number.MAX_SAFE_INTEGER;
  const queues = EVENT_KIND_ORDER.map((kind) => events.filter((event) => (event.kind ?? "security") === kind).sort((a, b) => dateKey(a) - dateKey(b)));
  queues.push(events.filter((event) => !EVENT_KIND_ORDER.includes((event.kind ?? "security") as EventKind)).sort((a, b) => dateKey(a) - dateKey(b)));
  const ordered: EventItem[] = [];
  while (queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const event = queue.shift();
      if (event) ordered.push(event);
    }
  }
  return ordered;
}
