
// 你也可以从 req.query.url 读取动态目标：const target = String(req.query.url || process.env.TARGET_URL || "");
const TARGET = process.env.TARGET_URL || ""; // e.g. https://httpbin.org/post

// 读取原始请求体（兼容 bodyParser 开/关、JSON/二进制）
async function readRawBody(req: VercelRequest): Promise<Buffer> {
  if (req.body && typeof req.body === "object") {
    // Next 默认 JSON 解析开启时走这里
    return Buffer.from(JSON.stringify(req.body));
  }
  // 未被解析时按流读取
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// 过滤不应透传的头
function sanitizeRequestHeaders(req: VercelRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (["host", "connection", "content-length", "accept-encoding"].includes(key)) continue;
    if (Array.isArray(v)) h.set(k, v.join(", "));
    else h.set(k, v as string);
  }
  // 若上游是 JSON 接口，确保 Content-Type
  if (!h.has("content-type")) h.set("content-type", "application/json");
  return h;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Only POST is allowed" });
  }
  const target = TARGET;
  if (!target) return res.status(400).json({ error: "TARGET_URL not configured" });

  try {
    const body = await readRawBody(req);
    const headers = sanitizeRequestHeaders(req);

    // 发起下游请求（用平台内置 fetch；老环境可 `npm i node-fetch` 并 `import fetch from 'node-fetch'`）
    const r = await fetch(target, {
      method: "POST",
      headers,
      body, // 保持原始 body
    });

    // 把下游响应头与状态码透传回客户端
    res.status(r.status);
    r.headers.forEach((value, key) => res.setHeader(key, value));
    // 一般代理不缓存
    res.setHeader("Cache-Control", "no-store");

    // 流式回传响应体
    if (r.body) {
      // @ts-ignore: Node Response has .body as Readable
      r.body.pipe(res);
    } else {
      const text = await r.text();
      res.send(text);
    }
  } catch (err: any) {
    console.error(err);
    res.status(502).json({ error: "Bad gateway", detail: String(err?.message || err) });
  }
}
