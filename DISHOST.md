# 디스호스트 배포

디스호스트는 루트의 `package.json`을 감지해 패키지를 자동 설치하고 최신 LTS
Node.js 환경에서 실행합니다. 이 저장소는 컴파일된 `dist/`도 포함하므로 호스팅
패널의 시작 명령은 다음 중 하나를 사용하면 됩니다.

```text
npm start
```

또는:

```text
node dist/index.js
```

## 업로드

다음 파일과 폴더를 GitHub 연동 또는 파일 업로드로 배포합니다.

```text
dist/
package.json
package-lock.json
```

소스도 함께 보관하려면 `src/`, `tests/`, `tsconfig.json`을 포함해도 됩니다.
`node_modules/`, `.env`, `data.json`은 업로드하지 않습니다.

## 환경변수

디스호스트 패널에서 최소 다음 값을 설정합니다.

```env
DISCORD_TOKEN=봇_토큰
BOT_OWNER_ID=소유자_사용자_ID
GUILD_IDS=서버_ID
DATABASE_PATH=data.json
SOURCE_CONCURRENCY=2
CTF_MONITOR_INTERVAL_SECONDS=120
```

나머지는 [.env.example](.env.example)을 참고합니다. 입퇴장 로그를 사용할 때만
`ENABLE_LOGGING_INTENTS=true`로 설정하고 Discord Developer Portal에서도
Server Members Intent를 켭니다.

## 데이터와 자원

- `data.json`에 문제, 역할/채널 ID, 행사 게시 이력이 저장됩니다.
- 디스호스트의 파일 백업 기능으로 `data.json`을 정기 백업하세요.
- 무료 기본 메모리가 128MB이므로 `SOURCE_CONCURRENCY=2`를 권장합니다.
- 자동 수집은 기본 3시간 간격입니다. 공유 호스팅에서 과도한 요청을 피하려면
  이 값을 지나치게 줄이지 마세요.
- CTF 새 문제 감시는 기본 120초이며 코드에서 60초보다 짧게 설정할 수 없습니다.
  오류와 사용량 제한 응답에는 자동으로 요청 간격을 늘립니다.
- 무료 인스턴스는 7일마다 대시보드에서 갱신해야 합니다.

배포 후 콘솔에서 `로그인 완료`와 `명령어 등록 완료`를 확인하고 Discord에서
`/봇 기능 추가`를 실행합니다.
