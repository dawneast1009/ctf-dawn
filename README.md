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
- CTFd/rCTF와 HSPACE FORGE 문제 Pull 및 저부하 신규 문제 감시
- CTFd Pull 시 대회 페이지의 시작·종료 일정을 자동 반영하고 공용 알림 갱신
- 외부 문제 ID 기준 이름·분야 갱신, 중복 감시 방지, 인증 만료 알림

DAWN은 외부 대회에 플래그를 제출하지 않습니다. 공개 API 또는 대회 페이지 GET 요청만 사용하며
기본 120초 간격으로 순차 조회합니다. 로그인 대회는 `/ctf pull`의 개인 입력 창에서
CTFd API 토큰 또는 로그인 후 브라우저의 `session` 쿠키값을 받습니다. rCTF API 토큰과
HSPACE Access-Token도 기존처럼 지원합니다. 인증정보는 AES-256-GCM으로 암호화해
대회별 자동 감시에 저장합니다. 인증정보가 만료되면 Pull로 새 값을 입력하며, 대회
종료 시각이 지나면 저장된 인증정보를 삭제하고 감시를 자동으로 끕니다.
감시 오류는 `🔑｜credential` 채널에 최대 한 시간에 한 번 알립니다. 데이터 변경 전
`data.json.bak` 백업을 만들며, 기본 DB가 손상되면 백업을 읽고 복구합니다.

CTFd 쿠키 방식은 브라우저에서 대회에 로그인한 뒤 개발자 도구의 Cookies에서
`session` 값을 복사해 `/ctf pull`의 `CTFd session 쿠키값` 칸에만 입력합니다.
`session=...` 전체를 넣어도 되고 값만 넣어도 됩니다. 이 값은 계정 인증정보이므로
Discord 메시지나 로그에 직접 올리지 마세요.

`/ctf create`에서는 일정 칸을 임시값으로 입력해도 됩니다. 이후 `/ctf pull`을 실행하면
CTFd 기본 페이지에 공개된 시작·종료 시각으로 대회 정보와 `대회-알림` 메시지를 자동
갱신합니다. 커스텀 테마가 일정을 노출하지 않거나 일정이 비어 있으면 입력한 값을 유지합니다.

Pull 주소는 기본적으로 공개 HTTPS 호스트만 허용합니다. 일반적인 웹 CTFd 로그인과
세션 쿠키 인증에는 영향이 없습니다. 내부망 HTTPS CTFd가 꼭 필요할 때만 신뢰할 수 있는
환경에서 `CTF_ALLOW_PRIVATE_HOSTS=true`를 설정하세요.

## 실행

Node.js 22를 권장합니다.

```bash
npm ci
cp .env.example .env
npm run check
npm start
```

Docker에서는 `/app/data`를 영구 볼륨으로 마운트해야 재배포 후 기록이 유지됩니다.

필수 Discord scope는 `bot`, `applications.commands`입니다. 봇에는 View Channels,
Send Messages, Embed Links, Read Message History, Manage Channels, Manage Roles,
Create Private Threads, Send Messages in Threads, Manage Threads 권한을 부여합니다.
DAWN 역할은 봇이 만드는 `대회명` 역할보다 위에 있어야 합니다. 기존 `CTF: 대회명`
역할도 봇이 다시 시작되면 `대회명`으로 변경됩니다.
