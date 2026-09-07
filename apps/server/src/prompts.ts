import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const cache = new Map<string, string>();

/** 读 prompts/<name>.md，{{var}} 占位替换 */
export function prompt(name: string, vars: Record<string, string> = {}): string {
  let tpl = cache.get(name);
  if (tpl === undefined) {
    tpl = fs.readFileSync(path.join(config.promptsDir, `${name}.md`), 'utf-8');
    cache.set(name, tpl);
  }
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

export function clearPromptCache() {
  cache.clear();
}
