import OpenAI from 'openai';
import { config } from '../config.js';

const client = new OpenAI({
  baseURL: config.openai.baseURL,
  apiKey: config.openai.apiKey,
  timeout: 120_000,
  maxRetries: 2,
});

export interface ChatOpts {
  /** 高频短任务用快模型 */
  fast?: boolean;
  /** 要求 JSON 输出（提示词里也要声明结构） */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/** 单轮对话补全 */
export async function chat(system: string, user: string, opts: ChatOpts = {}): Promise<string> {
  const model = opts.fast ? config.openai.modelFast : config.openai.model;
  // 部分网关要求：response_format=json_object 时消息里必须出现小写 "json"
  const userContent = opts.json ? `${user}\n\n（直接输出 json，不要其他内容）` : user;
  const req = {
    model,
    messages: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: userContent },
    ],
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4096,
  };
  try {
    const res = await client.chat.completions.create({
      ...req,
      ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
    });
    return res.choices[0]?.message?.content ?? '';
  } catch (e: any) {
    // response_format 不被该模型/网关支持时，去掉后重试（parseJsonLoose 已有容错）
    if (opts.json && e?.status === 400) {
      const res = await client.chat.completions.create(req);
      return res.choices[0]?.message?.content ?? '';
    }
    throw e;
  }
}

/** JSON 输出并解析（容忍 ```json 包裹与前后噪声；解析失败自动严格重试一次） */
export async function chatJson<T = any>(system: string, user: string, opts: Omit<ChatOpts, 'json'> = {}): Promise<T> {
  const raw = await chat(system, user, { ...opts, json: true });
  try {
    return parseJsonLoose<T>(raw);
  } catch {
    const retry = await chat(
      system,
      `${user}\n\n注意：你上一次的输出无法被解析。这次不要输出任何思考过程或解释，第一个字符必须是 { ，直接输出 json 对象本身。`,
      { ...opts, json: true, temperature: 0 },
    );
    return parseJsonLoose<T>(retry);
  }
}

/** 视觉理解（实测网关 kimi-k3 支持 image_url 输入）；失败返回 null 由调用方降级 */
export async function visionChat(imagePath: string, question: string): Promise<string | null> {
  try {
    const fs = await import('node:fs');
    const buf = fs.readFileSync(imagePath);
    if (buf.length > 8 * 1024 * 1024) return null; // 超大图不送模型
    const ext = imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';
    const dataUri = `data:image/${ext};base64,${buf.toString('base64')}`;
    const res = await client.chat.completions.create({
      model: config.openai.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      }],
      temperature: 0.2,
      max_tokens: 800,
    });
    const out = res.choices[0]?.message?.content?.trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

export function parseJsonLoose<T = any>(raw: string): T {
  const cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // 从文本中挖出第一个平衡的 {...} 或 [...]
    const start = cleaned.search(/[{[]/);
    if (start >= 0) {
      const open = cleaned[start];
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === open) depth++;
        else if (cleaned[i] === close) { depth--; if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1)) as T; }
      }
    }
    throw new Error(`LLM 输出无法解析为 JSON: ${raw.slice(0, 200)}`);
  }
}
