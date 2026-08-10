# DAWN

**Discord Attack & Wargame Navigator** — CTF 팀 운영만을 위한 Discord 봇입니다.

## 기능

- `/ctf create`: KST 일정, 참가 역할, 비공개 CTF 카테고리와 기본 채널 생성
- 공용 `대회-알림` 채널에 일정과 참가 버튼 게시(채널이 없으면 자동 생성)
- 참가 버튼으로 CTF 역할을 지급하고 해당 CTF `general` 채널에 참가 알림 게시
- `/ctf createchallenge category name`: 소문자 분야 채널에 문제 카드 생성
- 문제 카드의 참가 버튼을 처음 누를 때 비공개 스레드를 생성하고 이후 참가자를 같은 스레드에 추가
- `/ctf solve`: 개인 Solve 패널에서 Flag, Solver, Contributors를 확인한 뒤 기록
- `📃｜solve`에는 Solver 프로필이 포함된 문제별 해결 기록, `📣｜announce`에는 수정되는 분야별 진행 현황 게시
- 분야별 문제를 모두 풀면 채널 표시가 `⬜`에서 `🟦`로 변경되고 새 문제가 추가되면 `⬜`로 복귀
- `/ctf delete`: 확인 후 현재 CTF 공간, 참가 역할, 문제와 점수 기록 삭제
- 프로필, 기록, 리더보드, 점수 보정, 문제 수정·삭제
- CTFd/rCTF와 HSPACE FORGE 문제 Pull 및 공개 API 저부하 신규 문제 감시

DAWN은 외부 대회에 플래그를 제출하지 않습니다. 공개 API 또는 대회 페이지 GET 요청만 사용하며
기본 120초 간격으로 순차 조회합니다. 로그인 대회는 `/ctf pull`의 개인 입력 창에서
Access-Token을 받고 AES-256-GCM으로 암호화해 대회별 자동 감시에 저장합니다.
Refresh-Token은 사용하지 않으며 Access-Token 만료 시 Pull로 새 값을 입력합니다.
대회 종료 시각이 지나면 저장된 토큰을 삭제하고 감시를 자동으로 끕니다.

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
Create Private Threads, Send Messages in Threads, Manage Threads 권한을 부여합니다.
DAWN 역할은 봇이 만드는 `CTF: 대회명` 역할보다 위에 있어야 합니다.
