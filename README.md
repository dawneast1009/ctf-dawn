# DAWN

**Discord Attack & Wargame Navigator** — CTF 팀 운영만을 위한 Discord 봇입니다.

## 기능

- `/ctf create`: KST 일정, 참가 역할, 비공개 CTF 카테고리와 기본 채널 생성
- 참가 버튼으로 CTF 역할 지급
- `/ctf createchallenge category name`: 소문자 장르 채널과 문제 스레드 생성
- `/ctf solve`: Solver 1점, Contributor 0.5점 기록
- 현재 문제를 모두 풀면 파란색 All Solve, 새 문제가 추가되면 흰색으로 복귀
- 프로필, 기록, 리더보드, 점수 보정, 문제 수정·삭제
- CTFd/rCTF 공개 읽기 API Pull 및 저부하 신규 문제 감시

DAWN은 외부 대회에 플래그를 제출하지 않습니다. 공개 읽기 API만 자동 감시하며
기본 120초 간격으로 순차 조회합니다.

## 실행

Node.js 22를 권장합니다.

```bash
npm ci
cp .env.example .env
npm run check
npm start
```

필수 Discord scope는 `bot`, `applications.commands`입니다. 봇에는 View Channels,
Send Messages, Embed Links, Read Message History, Manage Channels, Manage Roles,
Create Public Threads, Send Messages in Threads, Manage Threads 권한을 부여합니다.
DAWN 역할은 봇이 만드는 `CTF: 대회명` 역할보다 위에 있어야 합니다.
