// 出口可達性探測（證據用，非產品）：Vercel 的出口能不能打 bilibili Index-Translate 上游。跑法見 ../../README.md
export const maxDuration = 120;

const UP = "https://index-translate.bilibili.com";
const UA = "Index-Translate-Proxy/0.1 (+https://github.com/Lawlietr/Index-Translate-Proxy)";
const KEEP = ["server", "cf-ray", "cf-cache-status", "x-cache-webcdn", "via", "content-type", "retry-after", "x-site-cdnid"];

function pick(h) { const o = {}; for (const k of KEEP) { const v = h.get(k); if (v) o[k] = v.length > 90 ? v.slice(0, 90) + "…" : v; } return o; }

export default async function handler(req, res) {
  const path = (req.url || "/").split("?")[0].replace(/^\//, "");
  if (path === "egress") {
    const out = {};
    for (const target of ["https://api.ipify.org?format=json", "httpbin.org", "https://ifconfig.me/ip"]) {
      try {
        const r = await fetch(target, { headers: { accept: "text/plain" } });
        out[target] = { status: r.status, body: (await r.text()).slice(0, 120) };
      } catch (e) { out[target] = { error: String(e).slice(0, 120) }; }
    }
    return res.status(200).json(out);
  }
  if (path === "models") {
    const t = [];
    const t0 = Date.now();
    let r, body;
    try {
      r = await fetch(`${UP}/v1/models`, { headers: { "user-agent": UA, accept: "application/json" } });
      body = await r.text();
    } catch (e) { return res.status(502).json({ error: String(e).slice(0, 300) }); }
    t.push({ step: "models", ms: Date.now() - t0 });
    return res.status(200).json({ status: r.status, headers: pick(r.headers), timing: t, body: body.slice(0, 300) });
  }
  if (path === "stream") {
    const t = [];
    const t0 = Date.now();
    const src = ["1. The cat sat on the mat.", "2. She opened the window slowly.", "3. Nobody saw her leave."];
    let r;
    try {
      r = await fetch(`${UP}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify({
          model: "Index-Translate-35B-A3B",
          messages: [
            { role: "system", content: "把使用者給的每一行譯成繁體中文。只輸出譯文，每行前有原編號。" },
            { role: "user", content: src.join("\n") },
          ],
          temperature: 0, stream: true, max_tokens: 256,
          stream_options: { include_usage: true },
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
    } catch (e) { return res.status(502).json({ error: String(e).slice(0, 300) }); }
    t.push({ step: "ttft", ms: Date.now() - t0 });
    const chunks = [];
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ ms: Date.now() - t0, bytes: value.length });
      if (chunks.length > 200) break;
    }
    t.push({ step: "stream_done", ms: Date.now() - t0 });
    return res.status(200).json({ status: r.status, headers: pick(r.headers), chunk_count: chunks.length, first_chunks: chunks.slice(0, 6), last: chunks.slice(-2), timing: t });
  }
  return res.status(200).json({ ok: true, routes: ["egress", "models", "stream"] });
}
