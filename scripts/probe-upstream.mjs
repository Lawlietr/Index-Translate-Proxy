#!/usr/bin/env node
// 上游公網端點探測（TODO.md 待做 1）。這不是規則 13 的「部署後探測 worker」，那個是 scripts/probe-live.mjs（待做 7）。
//
// 用法：
//   node scripts/probe-upstream.mjs                 # 預設群組
//   node scripts/probe-upstream.mjs ua model        # 只跑指定群組
//   node scripts/probe-upstream.mjs quota           # 配額群組（會燒掉大量 tokens，預設不跑）
//
// 輸出原則：控制台只印「每項一行」的摘要；完整證據（原始 SSE／錯誤 body）寫到 tests/fixtures/，
// 那裏同時是離線測試（待做 5）的資料來源。
//
// 已知限制：這台機器的出口 IP 與別人共用，429 的歸因只能看現象，不能證明節點。

import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import https from 'node:https'

const HOST = 'index-translate.bilibili.com'
const CHAT = '/v1/chat/completions'
const RESP = '/v1/responses'
const MODELS = '/v1/models'
const FIXED_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const OUT_DIR = 'tests/fixtures'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 系統提示：自己寫的簡短版本（不用上游 README 的原文，避免規則 10 的逐字複製）
const SYS = '你是一位專業翻譯員，把使用者給的文字翻譯成自然、地道的英文。只輸出譯文，不加說明。'

function chatPayload(text, extra = {}) {
  return {
    model: 'Index-Translate-35B-A3B',
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: text },
    ],
    stream: true,
    source_language: 'Chinese',
    target_translation: 'English',
    // 規則 9：唯一允許的注入。官方文件要求客戶端顯式關閉思考。
    chat_template_kwargs: { enable_thinking: false },
    ...extra,
  }
}

// 產生「像插件送過來的東西」：編號行，行長度不一致。編號是行對應協定的關鍵，必須保留。
function numberedText(targetChars) {
  const seed = '沉浸式翻譯外掛會把網頁上的文字送到翻譯服務，再把譯文放回原來的位置；編號就是兩邊對應的依據。'
  const lines = []
  let n = 1
  let len = 0
  while (len < targetChars) {
    const extra = n % 7 === 0 ? '這一行比較長，用來讓每行的長度不完全一致，更接近真實網頁。' : ''
    const line = `${n}. 第${n}節：${seed}${extra}`
    lines.push(line)
    len += line.length + 1
    n += 1
  }
  return lines.join('\n')
}

function countLineMarks(text) {
  const m = text.match(/^\s*(\d+)[.、]/gm) || []
  const nums = m.map((s) => parseInt(s.trim(), 10))
  return { marks: m.length, max: nums.length ? Math.max(...nums) : 0 }
}

// 直接用 node:https，才能精確控制「不送 User-Agent」這種情況（fetch 會自己補標頭）。
function send({ path = CHAT, method = 'POST', headers = {}, body, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const req = https.request({ host: HOST, path, method, headers: { host: HOST, ...headers } }, (res) => {
      const chunks = []
      let firstByte = 0
      res.on('data', (c) => {
        if (!firstByte) firstByte = Date.now() - started
        chunks.push(c)
      })
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw: Buffer.concat(chunks).toString('utf8'),
          firstByteMs: firstByte,
          totalMs: Date.now() - started,
        })
      })
    })
    req.on('error', (e) => resolve({ status: 0, error: String(e.message || e), totalMs: Date.now() - started }))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('client timeout'))
    })
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

// 解析 SSE：回傳 delta 數、拼出的文字、usage、finish_reason、model 回顯、第一個 delta 的時間。
function parseSse(raw, api = 'chat') {
  const out = { deltas: 0, text: '', usage: null, finish: null, modelEcho: null, eventTypes: {} }
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let obj
      try {
        obj = JSON.parse(data)
      } catch {
        out.badJson = (out.badJson || 0) + 1
        continue
      }
      out.eventTypes[obj.type || (obj.choices?.[0]?.delta ? 'chat.completion.chunk' : '?')] = 1
      if (obj.model) out.modelEcho = obj.model
      if (obj.usage) out.usage = obj.usage
      if (api === 'responses') {
        if (obj.type === 'response.output_text.delta') {
          out.deltas += 1
          out.text += obj.delta || ''
        }
      } else {
        const d = obj.choices?.[0]?.delta?.content
        if (typeof d === 'string') {
          out.deltas += 1
          out.text += d
        }
        const f = obj.choices?.[0]?.finish_reason
        if (f) out.finish = f
      }
    }
  }
  return out
}

const rows = []
function report(group, name, res, extra = {}) {
  const ct = String(res.headers?.['content-type'] || '')
  const isSse = ct.includes('event-stream')
  const row = {
    group,
    case: name,
    status: res.status,
    ms: res.totalMs,
    firstByteMs: res.firstByteMs ?? null,
    sse: isSse,
    bytes: res.raw ? Buffer.byteLength(res.raw) : 0,
    err: res.error || null,
    retryAfter: res.headers?.['retry-after'] ?? null,
    ...extra,
  }
  rows.push(row)
  const flags = Object.entries(extra)
    .filter(([, v]) => v !== null && v !== undefined && v !== 0)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ')
  console.log(
    `[${group}] ${name.padEnd(30)} ${String(row.status).padEnd(4)} ${String(row.ms).padStart(6)}ms ` +
      `${flags}`
  )
  return row
}

let fixtureSeq = 0
function saveFixture(name, content) {
  mkdirSync(OUT_DIR, { recursive: true })
  const file = `${OUT_DIR}/${name}`
  writeFileSync(file, content)
  console.log(`  ↳ fixtures/${name} (${Buffer.byteLength(content)} bytes)`)
  return file
}

function echoGet(host, path, headers) {
  return new Promise((resolve) => {
    const req = https.request({ host, path, method: 'GET', headers }, (res) => {
      const c = []
      res.on('data', (x) => c.push(x))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(c).toString('utf8') }))
    })
    req.on('error', (e) => resolve({ status: 0, error: String(e.message) }))
    req.end()
  })
}

async function groupSelfcheck() {
  // 確認 node:https 真的能控制 UA（含「完全不送」），否則 UA 群組的結論不可信。
  // 用會回憶標頭的服務（兩個鏡像，以先通的為主）。
  const ECHO = [
    { host: 'nghttp2.org', path: '/httpbin/headers' },
    { host: 'httpbin.org', path: '/headers' },
  ]
  let echo = null
  for (const e of ECHO) {
    const probe = await echoGet(e.host, e.path, { 'user-agent': 'probe/0' })
    if (probe.status === 200) {
      echo = e
      break
    }
    console.log(`  ↳ 回憶服務 ${e.host} 不可用（${probe.status || probe.error}），換下一個`)
  }
  if (!echo) {
    console.log('  ↳ 兩個回憶服務都不可用 → 「不送 UA」這格無法自證，結論要標為未證明')
    return
  }
  for (const [name, ua] of [
    ['none', undefined],
    ['empty', ''],
    ['custom', 'Index-Translate-Proxy/0.1 (probe)'],
  ]) {
    const headers = { accept: 'application/json' }
    if (ua !== undefined) headers['user-agent'] = ua
    const r = await echoGet(echo.host, echo.path, headers)
    let echoed = null
    try {
      const j = JSON.parse(r.raw)
      // httpbin 把標頭名首字母大寫（User-Agent），所以要不分大小寫比對。
      const h = j.headers || {}
      const key = Object.keys(h).find((k) => k.toLowerCase() === 'user-agent')
      echoed = key ? h[key] : '(none → 真的沒送)'
    } catch {}
    report('selfcheck', `ua-echo:${name}`, r, { echoed })
  }
}

async function groupUa() {
  const text = '1. 早安，今天的天氣不錯。\n2. 我們去海邊走路好嗎？'
  const cases = [
    ['no-user-agent', {}],
    ['ua-empty', { 'user-agent': '' }],
    ['ua-python-requests', { 'user-agent': 'python-requests/2.32.3' }],
    ['ua-python-urllib', { 'user-agent': 'Python-urllib/3.12' }],
    ['ua-curl', { 'user-agent': 'curl/8.5.0' }],
    ['ua-chrome', { 'user-agent': FIXED_UA }],
    ['ua-cf-workers', { 'user-agent': 'Cloudflare-Workers' }],
    ['ua-custom-token', { 'user-agent': 'Index-Translate-Proxy/0.1 (https://github.com/Lawlietr/Index-Translate-Proxy)' }],
    ['ua-official-client', { 'user-agent': 'Index-Translate-Client/1.0' }],
    ['ua-chrome+referer', { 'user-agent': FIXED_UA, referer: 'https://www.bilibili.com/', 'accept-language': 'zh-TW,zh;q=0.9' }],
  ]
  for (const [name, headers] of cases) {
    const r = await send({ headers: { 'content-type': 'application/json', ...headers } , body: chatPayload(text) })
    const p = r.status === 200 ? parseSse(r.raw) : null
    report('ua', name, r, { deltas: p?.deltas, out_chars: p ? p.text.length : null, body: r.status !== 200 ? r.raw.slice(0, 120) : undefined })
    if (r.status !== 200) saveFixture(`ua-${name}-${r.status}.json`, r.raw)
    await sleep(1200)
  }
}

async function groupModel() {
  // 上游 /v1/models 只宣告 35B-A3B，但未知模型的 400 body 自報了一串名字 →
  // 這裡逐個測「能不能真的跑」（不只是看 status），才能決定要不要放行（規則 1）。
  const text = '1. 這個模型的名字是用來測試它會不會真的跑。\n2. 今天天氣很好，我們去公園散步。'
  const models = [
    ['declared-35B-A3B', 'Index-Translate-35B-A3B'],
    ['undeclared-self-reported', 'index-mt-9b'],
    ['self-reported-2b', 'index-mt-2b'],
    ['self-reported-9b-syllable', 'index-mt-9b-syllable'],
    ['self-reported-2b-syllable', 'index-mt-2b-syllable'],
    ['retracted-homura', 'index-homura-35b-a3b'],
    ['suffix-preview', 'Index-Translate-35B-A3B-preview'],
    ['empty-model', ''],
    ['bogus', 'gpt-4o-mini'],
  ]
  for (const [name, model] of models) {
    const r = await send({
      headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA },
      body: chatPayload(text, { model }),
    })
    const p = r.status === 200 ? parseSse(r.raw) : null
    report('model', name, r, {
      modelEcho: p?.modelEcho,
      deltas: p?.deltas,
      outChars: p ? p.text.length : undefined,
      finish: p?.finish,
      preview: p && p.text ? p.text.replace(/\s+/g, ' ').slice(0, 60) : undefined,
      body: r.status !== 200 ? r.raw.slice(0, 200) : undefined,
    })
    if (r.status !== 200) saveFixture(`model-${name}-${r.status}.json`, r.raw)
    else saveFixture(`model-${name}-200.txt`, p.text)
    await sleep(1200)
  }
  const m = await send({ path: MODELS, method: 'GET', headers: { 'user-agent': FIXED_UA } })
  report('model', 'GET /v1/models', m)
  saveFixture('models.json', m.raw)
}

// 能不能「用」而不只是「能跑」：插件靠編號行把譯文對應回原文 → 逐模型数行對應。
async function groupLines() {
  const text = [
    '1. 會議九點開始。', '2. 請把報告帶來。', '3. 今天天氣很好。', '4. 他輕輕關上門。',
    '5. 這本書值得讀。', '6. 金錢買不到時間。', '7. 車站在橋的對面。', '8. 記得鎖門。',
  ].join('\n')
  const models = [
    ['declared-35B-A3B', 'Index-Translate-35B-A3B'],
    ['index-mt-9b', 'index-mt-9b'],
    ['index-mt-2b', 'index-mt-2b'],
    ['index-mt-9b-syllable', 'index-mt-9b-syllable'],
    ['index-mt-2b-syllable', 'index-mt-2b-syllable'],
  ]
  for (const [name, model] of models) {
    const r = await send({
      headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA },
      body: chatPayload(text, { model }),
    })
    const p = r.status === 200 ? parseSse(r.raw) : null
    const numbered = p ? (p.text.match(/^\s*\d+[.、]/gm) || []).length : 0
    report('lines', name, r, {
      modelEcho: p?.modelEcho,
      inLines: 8,
      numberedOut: numbered,
      outChars: p ? p.text.length : undefined,
      finish: p?.finish,
      preview: p ? p.text.replace(/\s+/g, ' ').slice(0, 90) : undefined,
    })
    if (p) saveFixture(`lines-${name}.txt`, p.text)
    await sleep(1200)
  }
}

async function groupUsage() {
  // 我們的設計是「usage 缺就不帶」，所以先確認上游到底給不給。
  const text = '1. 這段是用來看上游會不會回 usage 欄位的。\n2. 第二行，湊一點長度。'
  const cases = [
    ['stream-plain', { stream: true }],
    ['stream-include-usage', { stream: true, stream_options: { include_usage: true } }],
    ['non-stream', { stream: false }],
  ]
  for (const [name, extra] of cases) {
    const body = { ...chatPayload(text), ...extra }
    const r = await send({ headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA }, body })
    const p = r.headers?.['content-type']?.includes('event-stream') ? parseSse(r.raw) : null
    report('usage', name, r, { usage: p?.usage ?? (r.status === 200 ? tryUsage(r.raw) : null), deltas: p?.deltas })
    if (r.status === 200) saveFixture(`usage-${name}.${p ? 'sse' : 'json'}`, r.raw)
    await sleep(1200)
  }
}

function tryUsage(raw) {
  try {
    const j = JSON.parse(raw)
    return j.usage ?? null
  } catch {
    return null
  }
}

async function groupThink() {
  const text = '1. 打開思考之後會不會把標籤漏出來？這是規則 9 那段防禦性剝離要防的事。\n2. 第二行同樣要翻譯。'
  const cases = [
    ['thinking-off', { enable_thinking: false }],
    ['thinking-on', { enable_thinking: true }],
  ]
  for (const [name, kw] of cases) {
    const r = await send({
      headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA },
      body: chatPayload(text, { chat_template_kwargs: kw }),
    })
    const p = r.status === 200 ? parseSse(r.raw) : null
    const thinkMarks = p ? (p.text.match(/<think|<\|im_start\|>|<\|im_end\|>/g) || []).length : null
    report('think', name, r, { think_marks: thinkMarks, deltas: p?.deltas, out_chars: p?.text.length })
    if (r.status === 200) saveFixture(`think-${name}.sse`, r.raw)
    await sleep(1200)
  }
}

async function groupLen() {
  // 階梯：找到「保留幾行 / 從第幾行開始丟」的實際界線，才能定 MAX_INPUT_CHARS。
  const targets = [1000, 1500, 2000, 3000, 4000, 6000]
  for (const n of targets) {
    const text = numberedText(n)
    const inLines = text.split('\n').length
    const r = await send({ headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA }, body: chatPayload(text) })
    const p = r.status === 200 ? parseSse(r.raw) : null
    const marks = p ? countLineMarks(p.text) : null
    report('len', `chars=${n}`, r, {
      in_chars: text.length,
      in_lines: inLines,
      got_lines: marks?.marks,
      max_line: marks?.max,
      out_chars: p?.text.length,
      prompt_tokens: p?.usage?.prompt_tokens,
      deltas: p?.deltas,
    })
    if (r.status === 200) saveFixture(`len-${n}.sse`, r.raw)
    else saveFixture(`len-${n}-${r.status}.json`, r.raw)
    await sleep(2000)
  }
}

async function groupCap() {
  // 上一輪（len）發現 3,040 字元只回 42 行且 finish_reason=length，三檔輸出同長 → 上限在**輸出側**。
  // 這組要把那個上限換成 token 數，並確認客戶端的 max_tokens 會不會被尊重。
  const long = numberedText(6000)
  const r1 = await send({
    headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA },
    body: chatPayload(long, { stream_options: { include_usage: true } }),
  })
  const p1 = r1.status === 200 ? parseSse(r1.raw) : null
  const m1 = p1 ? countLineMarks(p1.text) : null
  report('cap', 'no-max-tokens(6000ch)', r1, {
    in_lines: long.split('\n').length,
    got_lines: m1?.marks,
    finish: p1?.finish,
    out_chars: p1?.text.length,
    completion_tokens: p1?.usage?.completion_tokens,
    prompt_tokens: p1?.usage?.prompt_tokens,
  })
  if (r1.status === 200) saveFixture('cap-no-max-tokens.sse', r1.raw)
  await sleep(2000)

  // 客戶端自己帶 max_tokens：尊重 → 輸出會停在對應長度（也證明 max_tokens 可作為規避 504 的手段）。
  const short = numberedText(900)
  const r2 = await send({
    headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA },
    body: chatPayload(short, { max_tokens: 40, stream_options: { include_usage: true } }),
  })
  const p2 = r2.status === 200 ? parseSse(r2.raw) : null
  report('cap', 'max_tokens=40', r2, {
    finish: p2?.finish,
    out_chars: p2?.text.length,
    completion_tokens: p2?.usage?.completion_tokens,
    got_lines: p2 ? countLineMarks(p2.text).marks : null,
  })
  if (r2.status === 200) saveFixture('cap-max-tokens-40.sse', r2.raw)
  await sleep(2000)

  // 邊界：2,000 完整、3,040 丟尾 → 把界線夾到 100 字元級，同時看行數與字元哪個是決定因素。
  for (const n of [2200, 2400, 2600, 2800]) {
    const t = numberedText(n)
    const r = await send({
      headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA },
      body: chatPayload(t, { stream_options: { include_usage: true } }),
    })
    const p = r.status === 200 ? parseSse(r.raw) : null
    const m = p ? countLineMarks(p.text) : null
    report('cap', `bisect=${n}`, r, {
      in_lines: t.split('\n').length,
      got_lines: m?.marks,
      finish: p?.finish,
      completion_tokens: p?.usage?.completion_tokens,
    })
    await sleep(2000)
  }
}

async function groupQuota() {
  // 官方文件說 60,000 tokens/min per IP。這裡只觀察現象：連續送，看第幾次出現 429 與 retry-after。
  const text = numberedText(900)
  let hit = null
  for (let i = 1; i <= 12; i++) {
    const r = await send({ headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA }, body: chatPayload(text) })
    const p = r.status === 200 ? parseSse(r.raw) : null
    report('quota', `req#${i}`, r, { retry_after: r.headers?.['retry-after'] ?? null, usage: p?.usage ?? null })
    if (r.status === 429) {
      saveFixture('rate-limit-429.json', r.raw)
      hit = i
      break
    }
    await sleep(1500)
  }
  console.log(hit ? `  ↳ 第 ${hit} 次出現 429` : '  ↳ 12 次內未觸發 429（無法由此推定計數方式）')
}

async function groupBurst() {
  // 目標是碰出 429（離線測試需要它的真實 body）。併發送，快速堆 token。
  const text = numberedText(2400)
  const jobs = Array.from({ length: 10 }, (_, i) =>
    send({
      headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA },
      body: chatPayload(text, { stream_options: { include_usage: true } }),
    }).then((r) => {
      const p = r.headers?.['content-type']?.includes('event-stream') ? parseSse(r.raw) : null
      report('burst', `parallel#${i + 1}`, r, {
        retry_after: r.headers?.['retry-after'] ?? null,
        completion_tokens: p?.usage?.completion_tokens,
        prompt_tokens: p?.usage?.prompt_tokens,
        finish: p?.finish,
      })
      if (r.status === 429) saveFixture('rate-limit-429.json', r.raw)
    })
  )
  await Promise.all(jobs)
}


async function groupRaise() {
  // 上一輪發現預設完成上限是 2048 tokens。能不能用 max_tokens 抬高？能的話切塊門檻可以放寬。
  for (const [name, chars, maxTokens] of [
    ['max_tokens=4096/3000ch', 3000, 4096],
    ['max_tokens=8192/6000ch', 6000, 8192],
  ]) {
    const t = numberedText(chars)
    const r = await send({
      headers: { 'content-type': 'application/json', 'user-agent': FIXED_UA },
      body: chatPayload(t, { max_tokens: maxTokens, stream_options: { include_usage: true } }),
    })
    const p = r.status === 200 ? parseSse(r.raw) : null
    const m = p ? countLineMarks(p.text) : null
    report('raise', name, r, {
      in_lines: t.split(/\r?\n/).length,
      got_lines: m?.marks,
      finish: p?.finish,
      completion_tokens: p?.usage?.completion_tokens,
      out_chars: p?.text.length,
    })
    if (r.status === 200) saveFixture(`raise-${maxTokens}.sse`, r.raw)
    await sleep(2000)
  }
}

const GROUPS = {
  selfcheck: groupSelfcheck,
  ua: groupUa,
  model: groupModel,
  lines: groupLines,
  usage: groupUsage,
  think: groupThink,
  len: groupLen,
  cap: groupCap,
  quota: groupQuota,
  burst: groupBurst,
  raise: groupRaise,
}

const picked = process.argv.slice(2).filter((a) => GROUPS[a])
const list = picked.length ? picked : ['selfcheck', 'ua', 'model', 'usage', 'think']
mkdirSync(OUT_DIR, { recursive: true })
for (const g of list) {
  console.log(`\n=== ${g} ===`)
  await GROUPS[g]()
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
saveFixture(`probe-${stamp}.json`, JSON.stringify({ ranAt: new Date().toISOString(), groups: list, rows }, null, 2))
console.log(`\n共 ${rows.length} 筆，摘要寫入 tests/fixtures/probe-${stamp}.json`)
