import React, { useState } from 'react';
import { post } from '../lib/api';
import { inline } from '../components/Markdown';

const HEADER_COLOR: Record<string, string> = {
  blue: '#3370ff', green: '#34c724', orange: '#ff8800', red: '#f54a45',
  purple: '#7b67ee', grey: '#8f959e', wathet: '#14c0ff', turquoise: '#0fbfbf',
  yellow: '#e0b400', carmine: '#eb5ab5', violet: '#7b67ee', indigo: '#5e6ad2',
};

/** lark_md 子集：**粗体**、`code`、[链接](url)、> 引用行、换行 */
function LarkMd({ content }: { content: string }) {
  const lines = String(content ?? '').split('\n');
  return (
    <>
      {lines.map((line, i) =>
        line.startsWith('>')
          ? <span className="quote-line" key={i}>{inline(line.replace(/^>\s?/, ''))}</span>
          : <React.Fragment key={i}>{inline(line)}{i < lines.length - 1 ? <br /> : null}</React.Fragment>,
      )}
    </>
  );
}

/** 飞书交互卡片渲染器（header / div / fields / action / note / hr 子集） */
export function FeishuCard({ card, msgId, operatorId }: { card: any; msgId: string; operatorId: string }) {
  const [clicked, setClicked] = useState<string | null>(null);
  if (!card || typeof card !== 'object') return null;

  const header = card.header;
  const elements: any[] = card.elements ?? [];

  const onClick = async (btn: any, idx: number) => {
    if (btn.url) return;
    setClicked(String(idx));
    try {
      await post('/api/mock/card-click', { msgId, operatorId, value: btn.value ?? {} });
    } finally {
      setTimeout(() => setClicked(null), 800);
    }
  };

  return (
    <div className="fcard">
      {header && (
        <div className="fcard-header" style={{ background: HEADER_COLOR[header.template] ?? '#3370ff' }}>
          {header.title?.content ?? ''}
        </div>
      )}
      <div className="fcard-body">
        {elements.map((el, i) => {
          if (el.tag === 'div' && el.fields) {
            return (
              <div className="fcard-fields" key={i}>
                {el.fields.map((f: any, j: number) => (
                  <div className="fcard-field" key={j}><LarkMd content={f.text?.content ?? ''} /></div>
                ))}
              </div>
            );
          }
          if (el.tag === 'div') {
            return <div className="fcard-div" key={i}><LarkMd content={el.text?.content ?? ''} /></div>;
          }
          if (el.tag === 'action') {
            return (
              <div className="fcard-actions" key={i}>
                {(el.actions ?? []).map((btn: any, j: number) => {
                  const cls = `fcard-btn ${btn.type === 'primary' ? 'primary' : btn.type === 'danger' ? 'danger' : ''}`;
                  if (btn.url) {
                    // mock 产出文档是本站相对链接，留在当前页；真飞书链接才开新标签
                    const external = /^https?:/i.test(btn.url);
                    return (
                      <a key={j} href={btn.url} target={external ? '_blank' : undefined} rel="noreferrer">
                        <button className={cls}>{btn.text?.content ?? '打开'}</button>
                      </a>
                    );
                  }
                  return (
                    <button key={j} className={cls} disabled={clicked !== null} onClick={() => onClick(btn, j)}>
                      {clicked === String(j) ? '处理中…' : btn.text?.content ?? '按钮'}
                    </button>
                  );
                })}
              </div>
            );
          }
          if (el.tag === 'note') {
            return <div className="fcard-note" key={i}>{(el.elements ?? []).map((n: any) => n.content ?? '').join(' ')}</div>;
          }
          if (el.tag === 'hr') return <hr className="fcard-hr" key={i} />;
          return null;
        })}
      </div>
    </div>
  );
}
