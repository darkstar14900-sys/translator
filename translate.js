// GitHub Actions에서 실행되는 번역 스크립트
// translator-1-1.html 의 chunkText / callAPI / 재시도 로직을 그대로 이식했습니다.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_PROMPT = `당신은 중국 소설 전문 번역가입니다. 아래 원칙을 반드시 지켜 번역하세요.

## 핵심 원칙
### 1. 100% 한국어 번역 (원문 출력 절대 금지)
- 번역 결과에 중국어(한자)가 단 한 글자라도 남아있어서는 안 됩니다.
- AI가 임의로 번역을 회피하고 원문을 그대로 복사해 출력하는 것을 엄격히 금지합니다.

### 2. 완전한 충실도
- 원문의 모든 문장, 묘사, 대화를 빠짐없이 번역한다.
- 요약하거나 생략하지 않는다.

### 3. 성인 묘사 완전 번역 (회피 금지)
- 노골적인 묘사나 행위가 등장하더라도 절대 검열하거나 번역을 회피하지 마세요.
- 축약·완화·생략 없이 원문 표현 강도를 그대로 재현하되, NTR(네토라레) 관련 요소만 배제합니다.

## 출력 규칙
- 번역문만 출력한다. 주석·설명 불필요. 원문 포함 금지.`;

const INPUT_FILE = process.env.INPUT_FILE;
const MODEL = process.env.MODEL || 'deepseek/deepseek-chat';
const API_KEY = process.env.OPENROUTER_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY; // "owner/repo" 형태, Actions가 자동으로 제공
const GH_REF = process.env.GITHUB_REF_NAME || 'main';
const COMMIT_EVERY = 10; // 이 청크 개수마다 중간 저장 커밋 (타임아웃/중단 대비)
const START_TIME = Date.now();
const MAX_RUNTIME_MS = (5 * 60 + 40) * 60 * 1000; // 5시간 40분 - GitHub의 6시간 강제종료 전에 스스로 멈추기 위한 여유시간

if (!INPUT_FILE) { console.error('INPUT_FILE 환경변수가 없습니다.'); process.exit(1); }
if (!API_KEY) { console.error('OPENROUTER_API_KEY 시크릿이 설정되지 않았습니다.'); process.exit(1); }
if (!fs.existsSync(INPUT_FILE)) { console.error(`입력 파일을 찾을 수 없습니다: ${INPUT_FILE}`); process.exit(1); }

// 저장소 루트에 prompt.txt 파일이 있으면 그것을 커스텀 프롬프트로 사용, 없으면 기본값
const promptPath = path.join(process.cwd(), 'prompt.txt');
const SYSTEM_PROMPT = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : DEFAULT_PROMPT;

const baseName = path.basename(INPUT_FILE).replace(/\.[^.]+$/, '');
const outDir = path.join(process.cwd(), 'output');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const progressPath = path.join(outDir, `${baseName}.progress.json`);
const finalPath = path.join(outDir, `${baseName}_번역본.txt`);
const partialPath = path.join(outDir, `${baseName}_진행중.txt`);

// translator-1-1.html 의 chunkText()와 동일한 로직
function chunkText(text, max = 500) {
  const paras = text.split('\n');
  const out = [];
  let cur = '';
  for (const p of paras) {
    const candidate = cur ? cur + '\n' + p : p;
    if (candidate.length > max && cur.trim()) {
      out.push(cur);
      cur = p;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.filter(c => c.trim().length > 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callAPI(text) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + API_KEY,
      'HTTP-Referer': 'https://github.com',
      'X-Title': 'CN-KR Novel Translator (Actions)'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `다음 중국어 원문을 100% 한국어로 완벽하게 번역해주세요. 한자(중국어)를 그대로 출력하는 것은 엄격히 금지됩니다.\n\n[원문]\n${text}` }
      ]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `API 오류 ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// 시간 제한에 걸려 못 끝냈을 때, GitHub한테 "다음 번역 실행을 자동으로 시작해줘" 라고 요청
async function triggerSelfRestart() {
  if (!GH_TOKEN || !GH_REPO) {
    console.error('자동 재시작 실패: GITHUB_TOKEN 또는 저장소 정보(GITHUB_REPOSITORY)가 없습니다. 수동으로 Run workflow를 다시 눌러주세요.');
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/translate.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: GH_REF, inputs: { input_file: INPUT_FILE, model: MODEL } })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('다음 실행 자동 예약 실패:', res.status, t, '-> 수동으로 Run workflow를 다시 눌러주세요.');
    } else {
      console.log('✅ 다음 번역 실행이 자동으로 예약되었습니다. 잠시 후 저절로 이어서 시작됩니다.');
    }
  } catch (err) {
    console.error('다음 실행 자동 예약 중 오류:', err.message, '-> 수동으로 Run workflow를 다시 눌러주세요.');
  }
}

function commitProgress(message) {
  try {
    execSync('git add output/', { stdio: 'inherit' });
    execSync('git diff --cached --quiet', { stdio: 'ignore' });
    // 위 명령이 예외 없이 끝나면 변경사항이 없다는 뜻 -> 커밋 스킵
    return;
  } catch (e) {
    // git diff --cached --quiet 가 실패(exit 1) = 변경사항 있음 -> 커밋 진행
  }
  try {
    execSync(`git commit -m "${message}"`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
    console.log(`중간 저장 커밋 완료: ${message}`);
  } catch (err) {
    console.error('커밋/푸시 실패 (번역은 계속 진행):', err.message);
  }
}

async function main() {
  execSync('git config user.name "translate-bot"');
  execSync('git config user.email "actions@github.com"');

  const raw = fs.readFileSync(INPUT_FILE, 'utf-8');
  const chunks = chunkText(raw);
  const total = chunks.length;
  console.log(`총 ${total}개 청크로 분할됨. 모델: ${MODEL}`);

  let cursor = 0;
  let results = new Array(total).fill(null);

  // 이전에 중단된 진행상황이 있으면 이어서 시작 (html의 이어하기 기능과 동일한 개념)
  if (fs.existsSync(progressPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
      if (saved.total === total) {
        cursor = saved.cursor;
        results = saved.results;
        console.log(`이전 진행상황 발견 -> ${cursor}/${total} 부터 이어서 시작`);
      }
    } catch (e) { console.error('진행상황 파일 파싱 실패, 처음부터 시작합니다.'); }
  }

  let timeUp = false;

  for (let i = cursor; i < total; i++) {
    if (Date.now() - START_TIME > MAX_RUNTIME_MS) {
      timeUp = true;
      console.log(`시간 제한(5시간40분) 도달. 지금까지 ${cursor}/${total} 완료. 안전하게 저장하고 다음 회차를 예약합니다.`);
      break;
    }
    let translated = null;
    for (let retry = 0; retry < 5; retry++) {
      try {
        if (retry > 0) {
          const wait = retry * 4000;
          console.log(`청크 ${i + 1}/${total} 재시도 ${retry}/5 (${wait / 1000}초 대기)`);
          await sleep(wait);
        }
        translated = await callAPI(chunks[i]);
        const cjk = translated.match(/[\u4e00-\u9fa5]/g);
        if (cjk && cjk.length > 15) throw new Error('중국어 원문 출력 감지됨 (검열 회피 오류)');
        break;
      } catch (e) {
        if (retry === 4) translated = `[청크 ${i + 1} 번역 실패: ${e.message}]`;
        else translated = null;
      }
    }
    results[i] = translated;
    cursor = i + 1;
    console.log(`[${cursor}/${total}] 완료`);

    fs.writeFileSync(progressPath, JSON.stringify({ cursor, total, results }));
    fs.writeFileSync(partialPath, results.filter(Boolean).join('\n\n'));

    if (cursor % COMMIT_EVERY === 0) {
      commitProgress(`중간 저장 ${cursor}/${total}: ${baseName}`);
    }
  }

  if (timeUp) {
    // 마지막 상태를 확실히 커밋하고, 다음 실행을 자동으로 예약한 뒤 정상 종료 (에러 아님)
    commitProgress(`시간 제한으로 일시중단, 자동 이어서 예약 ${cursor}/${total}: ${baseName}`);
    await triggerSelfRestart();
    return;
  }

  const finalText = results.join('\n\n');
  fs.writeFileSync(finalPath, finalText);
  if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
  if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);

  commitProgress(`번역 완료: ${baseName}`);
  console.log('전체 번역 완료');
}

main().catch(err => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
