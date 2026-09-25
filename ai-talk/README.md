# ai-talk: Claude Code ↔ Codex 실시간 대화

Claude Code CLI와 Codex CLI를 번갈아 실행해서 **두 AI가 서로의 답을 받아 가며 대화**하게 하는 중계 스크립트입니다.

- 각 CLI는 내 컴퓨터에 로그인된 계정으로 돌아갑니다. Claude 차례에는 Claude 구독 사용량이, Codex 차례에는 ChatGPT 구독(또는 OpenAI API 키) 사용량이 쓰입니다. 토큰을 한 곳에 합치는 게 아니라 각자 자기 몫을 쓰면서 대화하는 방식입니다.
- 대화 기록은 공유 메모리 폴더(`ai-project-memory/talks/`)에 마크다운으로 남기 때문에 다음 세션에서 두 AI 모두 참고할 수 있습니다.
- 의존성이 없는 파일 하나(`ai-talk.mjs`)라서 복사만 하면 됩니다. Node 18 이상이 필요합니다.

## 준비

**내 컴퓨터**(macOS, Linux, Windows)에서 실행하세요. 클라우드 세션(claude.ai/code)에서는 Codex 로그인도 OpenAI 쪽 네트워크 연결도 없어서 Codex를 부를 수 없습니다.

```bash
# Claude Code: 설치 후 claude 실행 → /login
# Codex
npm i -g @openai/codex
codex login          # ChatGPT 계정으로 로그인
```

둘 다 `claude -p "hi"`, `codex exec "hi"`가 각각 응답하면 준비 끝입니다.

## 사용법

프로젝트 폴더에서 실행합니다. Claude Code나 Codex 세션 안에서 도구로 돌리지 말고 **일반 터미널**에서 실행하세요.

```bash
node ai-talk/ai-talk.mjs "로그인을 세션 방식으로 할지 JWT로 할지 정해줘"
node ai-talk/ai-talk.mjs -t 12 --first codex "결제 모듈 리팩터링 계획 세워줘"
node ai-talk/ai-talk.mjs -w "아까 합의한 대로 README 정리해줘"    # 파일 수정 허용
```

| 옵션 | 설명 | 기본값 |
|---|---|---|
| `-t, --turns N` | 최대 발언 수 | 8 (각자 4번) |
| `--first NAME` | 먼저 말할 쪽 (`claude` / `codex`) | `claude` |
| `-C, --dir PATH` | 프로젝트 폴더 | 현재 폴더 |
| `--memory PATH` | 공유 메모리 폴더 | 자동 탐색 |
| `-w, --write` | 파일 수정 허용 | 끔 (읽기 전용 토론) |
| `--claude-model M` / `--codex-model M` | 모델 지정 | 각 CLI 기본값 |
| `--timeout MIN` | 한 턴 최대 시간(분) | 20 |

### 실행 중 조작

| 입력 | 동작 |
|---|---|
| 아무 글 + Enter | 다음 차례부터 두 AI 모두에게 `[사용자]` 메시지로 전달 |
| `/q` + Enter | 지금 턴이 끝나면 종료 |
| Ctrl+C | 바로 중단 (기록은 남음) |

### 끝난 뒤

마지막에 두 세션의 이어가기 명령이 출력됩니다. 토론 내용을 전부 기억하는 상태로 한쪽과 직접 이어서 작업할 수 있습니다.

```bash
claude --resume <세션ID>   # 프로젝트 폴더에서
codex resume <세션ID>
```

## 동작 방식

1. 첫 차례에는 규칙(메모리 먼저 읽기, 간결하게, 합의되면 `[[DONE]]`)과 주제를 보냅니다.
2. 그 뒤로는 **상대의 새 메시지만** 넘깁니다. 두 AI 모두 자기 세션을 이어가서(`claude -p --resume`, `codex exec resume`) 앞의 대화를 이미 기억하기 때문에 전체 대화를 다시 보낼 필요가 없습니다.
3. 두 AI가 연달아 `[[DONE]]`을 붙이거나(합의) 최대 발언 수에 닿으면 끝납니다.

## 토큰 사용량

매 턴마다 `입력 (캐시) · 출력` 토큰이 출력되고, 끝에 양쪽 합계가 나옵니다. Claude 쪽의 "API 환산" 금액은 API 요금으로 계산한 추정치라, 구독(Pro/Max)으로 로그인했다면 실제로 청구되지 않습니다.

턴이 쌓일수록 매 턴 처리하는 대화 맥락이 커집니다. 대부분 캐시로 처리되지만 사용량 한도에는 반영되니, 필요한 만큼만 `-t`로 늘리세요.

## 안전장치

- **기본은 읽기 전용**입니다. Claude는 `Edit`/`Write` 도구가 막히고(Claude 설정에서 따로 허용해 둔 셸 명령은 예외), Codex는 `read-only` 샌드박스에서 돕니다.
- `-w`를 주면 Claude는 파일 편집이 자동 승인(`acceptEdits`, 셸 명령은 설정에서 허용한 것만 실행)되고, Codex는 `workspace-write` 샌드박스로 바뀝니다. 차례대로 돌아서 동시 수정 충돌은 없지만, 한 AI의 말이 그대로 다른 AI의 지시가 되니 **git 커밋을 해 두고** 쓰세요.

## 공유 메모리 폴더

프로젝트 폴더에서 `ai-project-memory`, `.ai-project-memory`, `ai-memory`, `.ai-memory`, `memory`, `.memory` 순서로 찾습니다. 못 찾으면 기록을 `.ai-talk/`에 저장하고, 다른 폴더를 쓰려면 `--memory`로 지정하세요.

다음 세션에서도 토론 결과를 참고하게 하려면 `CLAUDE.md`와 `AGENTS.md`에 한 줄 적어 두면 됩니다.

```md
- Claude와 Codex의 토론 기록과 합의 내용은 ai-project-memory/talks/ 에 있다.
```

## 다른 방법: MCP 브리지

한쪽이 주도하면서 다른 쪽을 도구처럼 부르고 싶다면 [claude-codex-bridge](https://github.com/Dunqing/claude-codex-bridge)가 있습니다. `npx claude-codex-bridge setup` 한 번으로 Claude 안에서는 Codex를, Codex 안에서는 Claude를 부를 수 있습니다. 2026년 9월 기준(0.3.1), 코드를 수정하는 `codex_implement` 도구는 Codex CLI 0.157에서 없어진 `--full-auto` 플래그를 넘겨서 실패합니다. 질문·리뷰 도구는 정상 동작합니다.
