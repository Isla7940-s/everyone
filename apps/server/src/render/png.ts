import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { config } from '../config.js';

/** SVG 字符串 → PNG 文件（落在 out/ 下，满足 lark-cli cwd 相对路径约束），返回项目根相对路径 */
export function svgToPng(svg: string, fileName: string): string {
  fs.mkdirSync(config.outDir, { recursive: true });
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: { loadSystemFonts: true, defaultFontFamily: 'PingFang SC' },
    background: 'white',
  });
  const png = resvg.render().asPng();
  const abs = path.join(config.outDir, fileName);
  fs.writeFileSync(abs, png);
  return path.relative(config.root, abs);
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
}

/** 按显示宽度截断（中文算 2）并转义 */
export function clip(s: string, maxWidth: number): string {
  let w = 0;
  let out = '';
  for (const ch of s) {
    w += /[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (w > maxWidth) return escapeXml(out + '…');
    out += ch;
  }
  return escapeXml(out);
}
