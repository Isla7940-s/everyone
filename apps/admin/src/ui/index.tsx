import React, { useEffect, useRef, useState } from 'react';
import type { Person } from '@everyone/shared';
import { initial, type Tone } from '../lib/format';
import { IconClose, IconSearch } from './icons';

export * from './icons';

/* ---------------- 头像 ---------------- */

export function Avatar({ person, size = 32, bot }: { person?: Person | null; size?: 20 | 24 | 28 | 32 | 36 | 44 | 52; bot?: boolean }) {
  if (bot || !person) {
    return <span className={`avatar s${size} bot`}>E</span>;
  }
  return (
    <span className={`avatar s${size}`} style={{ background: person.avatarColor || '#7b67ee' }}>
      {initial(person.name)}
    </span>
  );
}

/* ---------------- 标签 ---------------- */

export function Tag({ tone = 'gray', dot, children, style }: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span className={`tag ${tone}`} style={style}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/* ---------------- 开关 ---------------- */

export function Switch({ checked, onChange, disabled, title }: {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="switch" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}

/* ---------------- 分段控件 ---------------- */

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- 日期 / 时间 ----------------
   默认渲染成自己排版的文本按钮，只在编辑时才挂 <input>：
   原生控件的空占位符与格式跟着浏览器语言走（mm/dd/yyyy、06:30 PM），页面管不着。 */

export function TimeField({
  value, display, kind = 'date', className, disabled,
  empty = '+ 设置', commitOn = 'change', onCommit,
}: {
  /** input 需要的值，'' 表示未设置 */
  value: string;
  /** 显示态文案，缺省时退回 value */
  display?: string;
  kind?: 'date' | 'datetime-local' | 'time';
  className?: string;
  disabled?: boolean;
  empty?: string;
  commitOn?: 'change' | 'blur';
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.focus();
    try {
      ref.current.showPicker?.();
    } catch {
      /* 不支持或手势窗口已过，退回普通聚焦 */
    }
  }, [editing]);

  // 提交成功后回到显示态
  useEffect(() => { setEditing(false); }, [value]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`tf-btn${value ? ' set' : ''}${className ? ` ${className}` : ''}`}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      >
        {value ? display || value : empty}
      </button>
    );
  }

  return (
    <input
      ref={ref}
      className={className}
      type={kind}
      defaultValue={value}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => { if (commitOn === 'change' && e.target.value) onCommit(e.target.value); }}
      onBlur={(e) => {
        if (commitOn === 'blur' && e.target.value && e.target.value !== value) onCommit(e.target.value);
        setEditing(false);
      }}
    />
  );
}

/* ---------------- 搜索框 ---------------- */

export function SearchInput({ value, onChange, placeholder, width }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: number;
}) {
  return (
    <div className="search" style={width ? { minWidth: width } : undefined}>
      <span className="sico"><IconSearch size={15} /></span>
      <input className="field" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ---------------- 空态 ---------------- */

export function Empty({ icon, title, children, tight }: {
  icon?: React.ReactNode;
  title?: string;
  children?: React.ReactNode;
  tight?: boolean;
}) {
  return (
    <div className={`empty ${tight ? 'tight' : ''}`}>
      {icon && <span className="eicon">{icon}</span>}
      {title && <div className="et">{title}</div>}
      {children && <div>{children}</div>}
    </div>
  );
}

/* ---------------- 模态 ---------------- */

export function Modal({ title, onClose, children, footer, width }: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" style={width ? { width } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><IconClose size={17} /></button>
        </div>
        <div className="m-body">{children}</div>
        {footer && <div className="m-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------- toast ---------------- */

export function Toast({ text }: { text: string }) {
  if (!text) return null;
  return <div className="toast">{text}</div>;
}

/* ---------------- 统计块 ---------------- */

export function Stat({ label, value, hint, hex }: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  hex?: string;
}) {
  const long = typeof value === 'string' && value.length > 5;
  return (
    <div className="stat">
      <div className="sl">
        {hex && <span className="sdot" style={{ background: hex }} />}
        {label}
      </div>
      <div className={long ? 'sv long' : 'sv'}>{value}</div>
      {hint && <div className="sh">{hint}</div>}
    </div>
  );
}

/* ---------------- 品牌标识 ---------------- */

export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size, borderRadius: size / 3 }}>
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="3.1" fill="#fff" />
        <circle cx="12" cy="4.2" r="2" fill="#fff" opacity="0.92" />
        <circle cx="19" cy="8.2" r="2" fill="#fff" opacity="0.74" />
        <circle cx="19" cy="16" r="2" fill="#fff" opacity="0.56" />
        <circle cx="12" cy="19.8" r="2" fill="#fff" opacity="0.74" />
        <circle cx="5" cy="16" r="2" fill="#fff" opacity="0.56" />
        <circle cx="5" cy="8.2" r="2" fill="#fff" opacity="0.92" />
      </svg>
    </span>
  );
}
