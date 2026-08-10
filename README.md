# CTF Phasor

TypeScript와 `discord.js`로 만든 통합 Discord 봇입니다. 서버별로 필요한 기능만
`/봇 기능 추가`에서 켤 수 있습니다.

## 통합 기능

### 1. 드림핵식 문제 관리

- `/문제 생성`: 문제명, 플래그, 장르, 티어를 입력해 포럼 문제 생성
- 정답자만 비공개 풀이 스레드에 입장
- `/문제 삭제`, `/문제 스코어보드`

### 2. CTF/워게임 운영

- `/ctf create name start end [team]`: KST 일정과 참가 역할, 비공개 카테고리 생성
- `general`, `bot-command`, `announce`, `credential`, `solve`, `feed` 기본 채널 생성
- `/ctf createchallenge category name`: 소문자 장르 채널 아래에 공개 문제 스레드 생성
- `/ctf solve`: 푼 사람 1점과 기여자 0.5점을 Discord 내부 기록으로 저장
- 현재 공개 문제를 모두 풀면 파란색 All Solve, 새 문제가 추가되면 다시 흰색으로 변경
- CTFd/rCTF 공개 읽기 API 문제 Pull과 저부하 신규 문제·TOP 10 감시
- 참가 버튼을 누른 사용자에게만 대회 역할과 비공개 채널 열람 권한 부여

외부 CTF 사이트의 플래그를 봇이 대신 제출하지 않습니다. 팀원은 대회 사이트에서
직접 제출하고, `/ctf solve`는 팀 내부 개인 기여도를 기록하는 명령입니다.

### 3. 서버 입장/퇴장 로그

- 입장·퇴장 기록과 초대 링크 사용자를 지정 로그 채널에 기록
- 이 기능을 사용할 때만 Discord의 `Server Members Intent`가 필요합니다.

### 4. 보안 행사·뉴스 공지

CTFtime, K-CTF, DACON, CODEGATE, SECON, 한국코드페어, KISA/KISIA,
보안뉴스와 공식 공지판·검색 RSS를 수집합니다. API 키가 설정되면 Naver,
Google, Bing 검색 결과도 후보로 사용합니다.

- CTF, AI 경진대회, 국내 보안 컨퍼런스, 국내 해커톤, 기타 정보보안,
  정보보안 소식으로 분류
- 1개월 이내, 2개월 이내, 그 외, 본선, 종료 포럼 자동 관리
- 기존 정보가 바뀌면 게시물 수정, 날짜 구간이 바뀌면 포럼 이동
- `/event_import`, `/event_import_url`에서 공지 원문을 분석하고 미리보기 후 등록
- `/event_add`, `/event_remove`, `/event_list_manual`로 수동 행사 관리
- 자동 동기화와 `/event_sync`, `/event_status`, `/event_upcoming`

## 소유자 전용 설정

`.env`의 `BOT_OWNER_ID`에는 봇 설정과 CTF 역할 구조를 관리할 Discord 사용자
ID 한 개를 넣습니다. 다음 작업은 해당 사용자만 실행할 수 있습니다.

- `/봇 기능 추가|삭제|목록`
- `/로그채널`, `/로그채널확인`
- `/ctf create|createchallenge|edit|deletechallenge|addpoint|deletepoint|pull|warning`
- 기존 호환 명령 `/ctf관리 대회삭제|import`
- CTF 참가 역할·비공개 카테고리를 새로 만드는 흐름

Discord는 `Administrator` 사용자가 모든 애플리케이션 명령을 볼 수 있도록
강제합니다. 따라서 다른 관리자의 명령 목록에서 완전히 숨길 수는 없지만,
봇은 실행 시 `BOT_OWNER_ID`를 다시 검사해 모든 변경을 거부합니다. 서버 설정
화면에서 직접 역할을 수정하는 Administrator까지 봇이 차단할 수는 없습니다.

## 설치

Node.js 22를 권장합니다.

```bash
git clone https://github.com/dawneast1009/ctf-phasor.git
cd ctf-phasor
npm ci
cp .env.example .env
npm run check
npm start
```

개발 중에는 다음 명령을 사용합니다.

```bash
npm run dev
```

## 필수 Discord 권한

- View Channels, Send Messages, Embed Links, Read Message History
- Manage Channels, Manage Roles, Create Public/Private Threads, Manage Threads
- 입퇴장 로그를 사용한다면 View Audit Log 권한과 Developer Portal의
  `Server Members Intent`, `Guild Invites` 접근 권한

봇 역할은 봇이 만드는 CTF 참가 역할보다 위에 있어야 합니다.

## 주요 환경변수

- `DISCORD_TOKEN`: 봇 토큰
- `BOT_OWNER_ID`: 민감한 설정을 변경할 유일한 사용자 ID
- `GUILD_IDS`: 즉시 명령어를 등록할 서버 ID 목록(쉼표 구분)
- `DATABASE_PATH`: 통합 JSON 데이터 파일 경로. 기본값 `data.json`
- `SYNC_INTERVAL_MINUTES`: 행사 자동 갱신 간격. 기본값 180분
- `LOOKAHEAD_DAYS`: 행사 조회 범위. 기본값 365일
- `SOURCE_CONCURRENCY`: 동시 수집기 수. 디스호스트 무료 플랜 권장값 2
- `CTF_MONITOR_INTERVAL_SECONDS`: CTF 공개 API 감시 간격. 기본 120초, 최소 60초
- `ENABLE_KCTF`: K-CTF 수집기 사용 여부
- `ENABLE_TRANSLATION`: 영문 상세 필드의 한국어 번역 여부
- `EXTRA_FEED_URLS`: 추가 JSON 행사 피드
- `DISCOVERY_FEED_URLS`: 기본 검색 RSS를 대체할 사용자 RSS
- `EVENT_PAGE_URLS`: 추가 공식 행사 페이지
- `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`, `GOOGLE_API_KEY`, `GOOGLE_CSE_ID`,
  `BING_API_KEY`: 선택 검색 API 설정

데이터 파일과 `.env`는 Git에 커밋하지 마세요.

CTF 감시는 로그인이나 플래그 제출 없이 공개 읽기 API만 사용합니다. 요청은 대회별
순차 실행되며 `429` 또는 서버 오류가 나면 최대 15분까지 지수 백오프합니다.
`/ctf pull`에 입력한 계정이나 읽기 토큰은 문제를 한 번 가져온 뒤 저장하지 않습니다.

## 디스호스트 배포

디스호스트는 `package.json`을 감지해 의존성을 자동 설치합니다. 이 저장소에는
컴파일된 `dist/`가 포함되므로 시작 명령은 `npm start`로 설정하면 됩니다.
환경변수와 데이터 백업 방법은 [DISHOST.md](DISHOST.md)를 참고하세요.

## Docker

```bash
docker build -t ctf-phasor .
docker run --env-file .env -v "$PWD/data:/data" ctf-phasor
```

## 검증

```bash
npm run check   # TypeScript 빌드 + 행사 파서 테스트
npm audit
```
