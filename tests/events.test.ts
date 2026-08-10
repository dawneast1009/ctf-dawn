import assert from "node:assert/strict";
import test from "node:test";
import type { EventItem } from "../src/store";
import {
  bucketForEvent,
  eventContentHash,
  eventRegion,
  interleaveEvents,
  normalizeGenres,
  parseEventNotice,
  periodAfterLabel,
  shouldIncludeEvent,
} from "../src/events/core";
import { parseBoanNewsFeed, searchTitleMatchesKind, titleYearMatchesEvent } from "../src/events/sources";

const DAY = 86_400_000;
const kst = (year: number, month: number, day: number, hour = 0, minute = 0) =>
  Date.UTC(year, month - 1, day, hour - 9, minute);

function event(patch: Partial<EventItem> = {}): EventItem {
  return {
    id: "1",
    guildId: "",
    title: "Example CTF",
    link: "https://example.com",
    source: "test",
    kind: "ctf",
    publishedAt: Date.now(),
    ...patch,
  };
}

test("공지 원문에서 CTF 필드를 추출한다", () => {
  const parsed = parseEventNotice(`[대회] HSPACE Security CTF 2026
주최: HSPACE
참가 대상: 대학생 및 일반인
접수 기간: 2026.06.01 ~ 2026.06.20 23:59
대회 일정: 2026.07.04 10:00 ~ 2026.07.05 18:00
진행 방식: 온라인
팀 구성: 최대 4명
https://example.com/register`);

  assert.equal(parsed.title, "HSPACE Security CTF 2026");
  assert.equal(parsed.kind, "ctf");
  assert.equal(parsed.organizer, "HSPACE");
  assert.equal(parsed.registrationDeadline, kst(2026, 6, 20, 23, 59));
  assert.equal(parsed.startsAt, kst(2026, 7, 4, 10));
  assert.equal(parsed.endsAt, kst(2026, 7, 5, 18));
  assert.equal(parsed.teamLimit, "최대 4명");
  assert.equal(parsed.participationMode, "온라인");
});

test("AI 대회와 보안 교육을 구분한다", () => {
  const ai = parseEventNotice(`2026 AI 서비스 개발 경진대회
접수 마감: 2026년 9월 1일
대회 일정: 2026년 9월 10일
https://example.com/ai`);
  const education = parseEventNotice(`2026 고등학생 정보보안 영재교육원 교육생 모집
모집 기간: 2026년 7월 1일 ~ 2026년 7월 20일
교육 일정: 2026년 8월 1일
참가 대상: 고등학생
https://example.com/security`);
  assert.equal(ai.kind, "ai");
  assert.equal(education.kind, "security");
});

test("OSINT는 CTF 장르로 유지하고 여러 장르를 합친다", () => {
  assert.deepEqual(normalizeGenres(["pwn", "reversing", "crypto"]), ["Pwn", "Reversing", "Crypto"]);
  assert.deepEqual(normalizeGenres(["OSINT"]), ["OSINT"]);
});

test("행사 변경 시 콘텐츠 해시가 바뀐다", () => {
  const original = event();
  const oldHash = eventContentHash(original);
  assert.notEqual(eventContentHash({ ...original, organizer: "Organizer" }), oldHash);
  assert.notEqual(eventContentHash({ ...original, posterUrl: "https://example.com/poster.png" }), oldHash);
});

test("본선, 예선, 종료 행사를 올바른 버킷으로 보낸다", () => {
  const now = Date.UTC(2026, 5, 1);
  assert.equal(bucketForEvent(event({ title: "Example CTF Finals", startsAt: now + 20 * DAY }), now), "final");
  assert.equal(bucketForEvent(event({ title: "Example CTF Quals", startsAt: now + 20 * DAY, summary: "본선 진출팀 선발" }), now), "within_1m");
  assert.equal(bucketForEvent(event({ title: "Finished CTF", startsAt: now - 2 * DAY, endsAt: now - DAY }), now), "ended");
  assert.equal(bucketForEvent(event({ title: "Final Security Conference", kind: "conference", startsAt: now + 20 * DAY }), now), "within_1m");
});

test("종료 행사는 추적 중일 때만 보관한다", () => {
  const now = Date.UTC(2026, 5, 7);
  const finished = event({ endsAt: now - 1 });
  assert.equal(shouldIncludeEvent(finished, { now, lookaheadDays: 365, tracked: false }), false);
  assert.equal(shouldIncludeEvent(finished, { now, lookaheadDays: 365, tracked: true }), true);
});

test("참가 대상 필드가 있는 정상 대회를 결과 기사로 오인하지 않는다", () => {
  const now = Date.UTC(2026, 5, 1);
  const upcoming = event({ startsAt: now + 10 * DAY, summary: "참가 대상: 전국 고등학생" });
  assert.equal(shouldIncludeEvent(upcoming, { now, lookaheadDays: 365, tracked: false }), true);
});

test("구체적인 해외 장소가 .kr 기사 도메인보다 우선한다", () => {
  assert.equal(eventRegion(event({ source: "검색API-CTF", link: "https://news.example.kr/event", location: "Tokyo, Japan" })), "global");
  assert.equal(eventRegion(event({ source: "CTFtime", link: "https://ctftime.org/event/1", location: "서울 코엑스" })), "kr");
  assert.equal(eventRegion(event({ source: "검색API-CTF-해외", location: "Online" })), "global");
});

test("보안뉴스 RSS 날짜와 정규 링크를 처리한다", () => {
  const xml = `<?xml version="1.0" encoding="euc-kr"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><item>
    <title><![CDATA[ 신규 보안 취약점 발견 ]]></title>
    <link>http://www.boannews.com/media/view.asp?idx=144063&amp;kind=3</link>
    <description><![CDATA[ 보안 업데이트가 필요합니다. ]]></description>
    <dc:date>Wed, 10 Jun 2026 18:51:00 +0900</dc:date>
  </item></channel>
</rss>`;
  const rows = parseBoanNewsFeed(xml, Date.UTC(2026, 5, 11));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].link, "https://www.boannews.com/media/view.asp?idx=144063");
  assert.equal(rows[0].startsAt, Date.UTC(2026, 5, 10, 9, 51));
});

test("연도가 생략된 두 번째 날짜를 같은 연도로 해석한다", () => {
  const dates = periodAfterLabel("접수 기간 2026. 12. 20. ~ 12. 31.", /접수\s*기간/);
  assert.deepEqual(dates, [kst(2026, 12, 20), kst(2026, 12, 31)]);
});

test("행사 종류를 라운드로빈으로 섞는다", () => {
  const rows = interleaveEvents([
    event({ id: "1", title: "CTF 1", kind: "ctf" }),
    event({ id: "2", title: "CTF 2", kind: "ctf" }),
    event({ id: "3", title: "Conference 1", kind: "conference" }),
    event({ id: "4", title: "Hackathon 1", kind: "hackathon" }),
  ]);
  assert.deepEqual(rows.map((row) => row.title), ["CTF 1", "Conference 1", "Hackathon 1", "CTF 2"]);
});

test("교수 부임 페이지를 AI 경진대회로 수집하지 않는다", () => {
  assert.equal(searchTitleMatchesKind("ai", "부산대학교 - 박진선 교수님 부임, 신임교수님 환영합니다!"), false);
  assert.equal(searchTitleMatchesKind("ai", "2026 부산 AI 서비스 개발 경진대회 참가자 모집"), true);
});

test("과거 연도 기사와 다른 연도의 사이드바 날짜를 행사로 쓰지 않는다", () => {
  const now = Date.UTC(2026, 6, 5);
  const wrong = event({ title: "2021 호남 사이버보안 컨퍼런스 개최", kind: "conference", startsAt: Date.UTC(2026, 9, 13) });
  assert.equal(searchTitleMatchesKind("hackathon", wrong.title), false);
  assert.equal(titleYearMatchesEvent(wrong.title, wrong, now), false);
});
