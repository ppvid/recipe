#!/usr/bin/env node
// ai-talk: Claude Code CLI와 Codex CLI를 번갈아 호출해서 둘이 서로 대화하게 하는 중계기.
//
// - 각 CLI는 이 컴퓨터에 로그인된 계정으로 실행된다. Claude 차례에는 Claude 사용량이,
//   Codex 차례에는 ChatGPT(또는 OpenAI API) 사용량이 쓰인다.
// - 두 에이전트 모두 자기 세션을 이어가므로(resume) 매 턴 상대의 새 메시지만 넘긴다.
// - 대화 기록은 공유 메모리 폴더의 talks/ 아래에 마크다운으로 남는다.
//
// 의존성 없음. Node 18 이상.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

const HELP = `사용법: node ai-talk.mjs [옵션] "대화 주제"

Claude Code와 Codex가 서로의 답을 받아 가며 번갈아 대화하게 합니다.
두 CLI 모두 이 컴퓨터에 설치되고 로그인돼 있어야 합니다.

옵션:
  -t, --turns N          최대 발언 수 (기본 8, 각자 4번)
      --first NAME       먼저 말할 쪽: claude | codex (기본 claude)
  -C, --dir PATH         프로젝트 폴더 (기본: 현재 폴더)
      --memory PATH      공유 메모리 폴더 (기본: ai-project-memory 등 자동 탐색)
  -w, --write            파일 수정 허용 (기본: 읽기 전용 토론)
      --claude-model M   Claude 모델 (예: opus, sonnet)
      --codex-model M    Codex 모델
      --timeout MIN      한 턴 최대 시간(분) (기본 20)
  -h, --help             도움말

실행 중:
  글 입력 후 Enter       다음 차례부터 두 AI 모두에게 [사용자] 메시지로 전달
  /q 입력 후 Enter       지금 턴이 끝나면 종료
  Ctrl+C                 바로 중단 (기록은 남음)`;

const DONE = '[[DONE]]';
const MEMORY_DIR_CANDIDATES = ['ai-project-memory', '.ai-project-memory', 'ai-memory', '.ai-memory', 'memory', '.memory'];
const IS_WIN = process.platform === 'win32';

let opts;
let positionals;
try {
  ({ values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      turns: { type: 'string', short: 't', default: '8' },
      first: { type: 'string', default: 'claude' },
      dir: { type: 'string', short: 'C', default: process.cwd() },
      memory: { type: 'string' },
      write: { type: 'boolean', short: 'w', default: false },
      'claude-model': { type: 'string' },
      'codex-model': { type: 'string' },
      timeout: { type: 'string', default: '20' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}

const topic = positionals.join(' ').trim();
if (opts.help || !topic) {
  console.log(HELP);
  process.exit(opts.help ? 0 : 2);
}
const maxTurns = Number(opts.turns);
const timeoutMs = Number(opts.timeout) * 60_000;
if (!Number.isInteger(maxTurns) || maxTurns < 1 || !(timeoutMs > 0) || !['claude', 'codex'].includes(opts.first)) {
  console.error('--turns 는 1 이상의 정수, --timeout 은 양수, --first 는 claude 또는 codex 여야 해요.');
  process.exit(2);
}

const projectDir = path.resolve(opts.dir);
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  console.error(`프로젝트 폴더가 없어요: ${projectDir}`);
  process.exit(2);
}
const memoryDir = findMemoryDir();
const talksDir = memoryDir ? path.join(memoryDir, 'talks') : path.join(projectDir, '.ai-talk');
fs.mkdirSync(talksDir, { recursive: true });
const logFile = path.join(talksDir, `${stamp()}-${slug(topic)}.md`);

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const red = paint('31');
const yellow = paint('33');

const agents = {
  claude: {
    label: 'Claude',
    bin: 'claude',
    paint: paint('38;5;208'),
    session: randomUUID(), // 첫 호출에서 이 ID로 세션을 만들고 이후 --resume
    started: false,
    pending: [],
    total: { input: 0, cached: 0, output: 0, costUsd: 0 },
    args() {
      const a = ['-p', '--output-format', 'stream-json', '--verbose', this.started ? '--resume' : '--session-id', this.session];
      if (opts.write) a.push('--permission-mode', 'acceptEdits');
      else a.push('--disallowedTools', 'Edit,Write,NotebookEdit');
      if (opts['claude-model']) a.push('--model', opts['claude-model']);
      return a; // 프롬프트는 stdin으로 보낸다
    },
    onEvent(ev, turn) {
      if (ev.type === 'assistant') {
        for (const part of ev.message?.content ?? []) {
          if (part.type === 'tool_use') progress(this, `${part.name} ${toolTarget(part.input)}`);
        }
      } else if (ev.type === 'result') {
        if (typeof ev.result === 'string') turn.text = ev.result.trim();
        if (ev.session_id) turn.session = ev.session_id;
        if (ev.is_error) {
          turn.failed = true;
          turn.errors.push(ev.result || ev.subtype || 'Claude 오류');
        }
        const u = ev.usage ?? {};
        const cached = u.cache_read_input_tokens ?? 0;
        turn.usage = {
          input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached,
          cached,
          output: u.output_tokens ?? 0,
          costUsd: ev.total_cost_usd ?? 0,
        };
      }
    },
    resumeHint() {
      return `claude --resume ${this.session}`;
    },
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    paint: paint('36'),
    session: null, // 첫 호출의 thread.started 이벤트에서 받는다
    started: false,
    pending: [],
    total: { input: 0, cached: 0, output: 0, costUsd: 0 },
    args() {
      const a = ['exec'];
      if (this.started) a.push('resume', this.session);
      a.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode=${opts.write ? 'workspace-write' : 'read-only'}`);
      if (opts['codex-model']) a.push('-m', opts['codex-model']);
      a.push('-'); // 프롬프트는 stdin으로 보낸다
      return a;
    },
    onEvent(ev, turn) {
      const item = ev.item ?? {};
      if (ev.type === 'thread.started') {
        turn.session = ev.thread_id;
      } else if (ev.type === 'item.started' && item.type === 'command_execution') {
        progress(this, `$ ${item.command}`);
      } else if (ev.type === 'item.completed' && item.type === 'file_change') {
        const files = (item.changes ?? [item]).map((ch) => ch.path).filter(Boolean);
        progress(this, `파일 수정 ${files.join(', ')}`);
      } else if (ev.type === 'item.completed' && item.type === 'agent_message') {
        turn.text = (item.text ?? '').trim(); // 마지막 agent_message가 최종 답
      } else if (ev.type === 'turn.completed') {
        const u = ev.usage ?? {};
        turn.usage = { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0, costUsd: 0 };
      } else if (ev.type === 'turn.failed') {
        turn.failed = true;
        turn.errors.push(ev.error?.message ?? JSON.stringify(ev.error));
      } else if (ev.type === 'error') {
        turn.errors.push(ev.message ?? JSON.stringify(ev)); // 재연결 같은 일시적 오류일 수 있어 실패로 치지 않음
      }
    },
    resumeHint() {
      return `codex resume ${this.session}`;
    },
  },
};

let stopRequested = false;
let current = null; // 실행 중인 CLI 프로세스

process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  console.log(yellow('\n중단하는 중... (한 번 더 누르면 강제 종료)'));
  if (current) kill(current);
});

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = line.trim();
  if (!msg) return;
  if (msg === '/q') {
    stopRequested = true;
    console.log(yellow('↳ 지금 턴이 끝나면 종료할게요.'));
    return;
  }
  agents.claude.pending.push(msg);
  agents.codex.pending.push(msg);
  appendLog(`\n## 사용자 · ${clock()}\n\n${msg}\n`);
  console.log(yellow(`↳ 다음 차례부터 두 AI에게 전달할게요: ${msg}`));
});

await main();
rl.close();
process.stdin.destroy();

async function main() {
  const order = opts.first === 'codex' ? [agents.codex, agents.claude] : [agents.claude, agents.codex];
  const mode = opts.write ? '파일 수정 허용' : '토론 (읽기 전용)';

  fs.writeFileSync(
    logFile,
    `# AI 대화: ${topic}\n\n- 시작: ${stamp().slice(0, 10)} ${clock().slice(0, 5)}\n- 프로젝트: \`${projectDir}\`\n- 모드: ${mode}\n- 순서: ${order[0].label} → ${order[1].label}\n`,
  );
  console.log(
    [
      `AI 대화 시작: ${topic}`,
      dim(`  ${order[0].label} → ${order[1].label} · 최대 ${maxTurns}턴 · ${mode}`),
      dim(`  공유 메모리: ${memoryDir ? rel(memoryDir) : '못 찾음 (--memory 로 지정 가능)'}`),
      dim(`  기록: ${rel(logFile)}`),
      dim('  끼어들기: 입력 후 Enter · /q 종료 · Ctrl+C 중단'),
    ].join('\n'),
  );

  let lastText = '';
  let lastDone = false;
  let reason = `최대 발언 수(${maxTurns}) 도달`;

  for (let n = 1; n <= maxTurns; n++) {
    if (stopRequested) {
      reason = '사용자가 중단';
      break;
    }
    const agent = order[(n - 1) % 2];
    const other = order[n % 2];
    const parts = [];
    if (!agent.started) parts.push(preamble(agent, other));
    parts.push(lastText ? `[${other.label}]\n${lastText}` : '네가 먼저 시작해. 주제에 대한 네 생각이나 제안을 말해줘.');
    if (agent.pending.length) parts.push(`[사용자]\n${agent.pending.splice(0).join('\n')}`);

    const at = clock();
    console.log(`\n${agent.paint(`━━ ${n} · ${agent.label}`)} ${dim(at)}`);
    const turn = await runTurn(agent, parts.join('\n\n'));

    if (turn.session) agent.session = turn.session;
    const ok = !turn.failed && turn.code === 0 && turn.text;
    if (ok && !agent.session) turn.errors.push('세션 ID를 받지 못해 대화를 이어갈 수 없어요.');
    if (!ok || !agent.session) {
      const errors = [...new Set(turn.errors)].slice(-5);
      const detail = [...errors, turn.stderr.trim().split('\n').slice(-10).join('\n')].filter(Boolean).join('\n');
      console.log(red(`${agent.label} 응답 실패`) + (detail ? `\n${dim(detail)}` : ''));
      appendLog(`\n## ${n}. ${agent.label} · ${at} · 실패\n\n\`\`\`\n${detail || '(출력 없음)'}\n\`\`\`\n`);
      reason = stopRequested ? '사용자가 중단' : `${agent.label} 오류`;
      break;
    }

    agent.started = true;
    for (const key of Object.keys(agent.total)) agent.total[key] += turn.usage?.[key] ?? 0;
    console.log(turn.text);
    console.log(dim(usageLine(turn.usage, turn.ms)));
    appendLog(`\n## ${n}. ${agent.label} · ${at}\n\n${turn.text}\n\n<sub>${usageLine(turn.usage, turn.ms)}</sub>\n`);

    const done = turn.text.includes(DONE);
    if (done && lastDone) {
      reason = `둘 다 ${DONE} (합의)`;
      break;
    }
    lastDone = done;
    lastText = turn.text;
  }

  const summary = [`- 종료 이유: ${reason}`];
  for (const a of order) summary.push(`- ${a.label} 합계: ${usageLine(a.total)}`);
  for (const a of order) if (a.started) summary.push(`- ${a.label}와 이어서 직접 대화: \`${a.resumeHint()}\` (프로젝트 폴더에서)`);
  appendLog(`\n---\n\n## 종료\n\n${summary.join('\n')}\n`);
  console.log(`\n${summary.join('\n')}\n기록: ${logFile}`);
  process.exitCode = reason.endsWith('오류') ? 1 : 0;
}

function preamble(agent, other) {
  const docs = `${memoryDir ? `공유 메모리 폴더(${rel(memoryDir)})와 ` : ''}CLAUDE.md, AGENTS.md 같은 프로젝트 문서`;
  return [
    `너는 ${agent.label}야. 지금 다른 AI 코딩 에이전트인 ${other.label}와 실시간으로 대화하고 있어.`,
    `중계 스크립트가 네 답을 그대로 ${other.label}에게 넘기고 ${other.label}의 답을 너에게 가져와. 사용자도 대화를 지켜보다가 [사용자] 메시지로 끼어들 수 있어.`,
    '',
    '규칙:',
    `- 시작하기 전에 ${docs}를 읽고 맥락을 맞춰. 단, ${rel(logFile)}는 지금 이 대화의 기록이니 읽지 않아도 돼.`,
    '- 한국어로, 핵심만 간결하게 말해. 인사나 상대 말 되풀이는 빼.',
    '- 동의하면 짧게 동의하고 다음 논점으로 넘어가. 반대하면 코드 위치나 트레이드오프 같은 근거를 대.',
    opts.write
      ? '- 파일 수정이 허용돼 있어. 둘이 합의한 변경만 네 차례에 하고, 무엇을 바꿨는지 파일 경로와 함께 말해줘.'
      : '- 지금은 토론 모드야. 파일을 수정하지 말고 읽기와 분석만 해.',
    `- 더 논의할 게 없으면 '결론:' 아래에 합의 내용을 3~5줄로 정리하고 마지막 줄에 ${DONE} 를 붙여. 둘이 연달아 ${DONE}를 붙이면 대화가 끝나.`,
    '',
    `주제: ${topic}`,
  ].join('\n');
}

function runTurn(agent, prompt) {
  return new Promise((resolve) => {
    const turn = { text: '', session: null, usage: null, errors: [], failed: false, stderr: '', code: null, ms: 0 };
    const startedAt = Date.now();
    // Windows에서는 npm으로 깐 CLI가 .cmd 파일이라 셸을 거쳐야 실행된다. 인자에 공백·특수문자가 없도록 유지할 것.
    const args = agent.args();
    const child = IS_WIN
      ? spawn([agent.bin, ...args].join(' '), { cwd: projectDir, shell: true })
      : spawn(agent.bin, args, { cwd: projectDir });
    current = child;

    let buf = '';
    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      agent.onEvent(ev, turn);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      turn.stderr = (turn.stderr + chunk).slice(-4000);
    });

    const timer = setTimeout(() => {
      turn.errors.push(`${opts.timeout}분 안에 끝나지 않아 중단했어요.`);
      kill(child);
    }, timeoutMs);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current = null;
      turn.ms = Date.now() - startedAt;
      resolve(turn);
    };
    child.on('error', (err) => {
      turn.errors.push(err.code === 'ENOENT' ? `'${agent.bin}' 명령을 찾을 수 없어요. 설치와 로그인을 확인하세요.` : err.message);
      finish();
    });
    child.on('close', (code) => {
      handleLine(buf);
      turn.code = code;
      finish();
    });
    child.stdin.on('error', () => {}); // 프롬프트를 다 읽기 전에 CLI가 죽어도(EPIPE) 여기서 터지지 않게
    child.stdin.end(prompt);
  });
}

function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 5000).unref();
}

function findMemoryDir() {
  if (opts.memory) return path.resolve(projectDir, opts.memory);
  for (const name of MEMORY_DIR_CANDIDATES) {
    const dir = path.join(projectDir, name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
}

function progress(agent, text) {
  console.log(dim(`  · ${agent.label}: ${oneLine(text, 100)}`));
}

function toolTarget(input = {}) {
  return String(input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query ?? '');
}

function usageLine(u, ms) {
  const parts = [];
  if (u) {
    parts.push(`입력 ${fmt(u.input)} (캐시 ${fmt(u.cached)}) · 출력 ${fmt(u.output)} 토큰`);
    if (u.costUsd) parts.push(`API 환산 $${u.costUsd.toFixed(3)}`);
  }
  if (ms !== undefined) parts.push(`${Math.round(ms / 1000)}초`);
  return parts.join(' · ');
}

function appendLog(text) {
  fs.appendFileSync(logFile, text);
}

function rel(p) {
  return path.relative(projectDir, p) || '.';
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function oneLine(s, max) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function slug(s) {
  return s.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'talk';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function clock(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}
