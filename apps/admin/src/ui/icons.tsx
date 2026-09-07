import React from 'react';

/** 线性图标集：1.7px 描边、圆角端点，与 OpenAI/飞书图标气质一致 */

export interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
  className?: string;
}

function svg(p: IconProps, children: React.ReactNode) {
  return (
    <svg
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={p.color ?? 'currentColor'}
      strokeWidth={p.strokeWidth ?? 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
      style={{ flexShrink: 0, display: 'block' }}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => svg(p, <>
  <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.5Z" />
  <path d="M9.5 20.5v-6h5v6" />
</>);

export const IconGrid = (p: IconProps) => svg(p, <>
  <rect x="4" y="4" width="7" height="8.5" rx="1.8" />
  <rect x="13" y="4" width="7" height="5" rx="1.8" />
  <rect x="13" y="11" width="7" height="9" rx="1.8" />
  <rect x="4" y="14.5" width="7" height="5.5" rx="1.8" />
</>);

export const IconTask = (p: IconProps) => svg(p, <>
  <rect x="4.5" y="4" width="15" height="16.5" rx="3" />
  <path d="m8.3 12 2.5 2.5 4.9-5" />
</>);

export const IconUsers = (p: IconProps) => svg(p, <>
  <circle cx="9" cy="8" r="3.2" />
  <path d="M3.5 19.2c.85-3.1 3.05-4.7 5.5-4.7s4.65 1.6 5.5 4.7" />
  <circle cx="16.8" cy="9.4" r="2.3" />
  <path d="M17 14.4c1.95.3 3.25 1.65 3.8 3.9" />
</>);

export const IconBot = (p: IconProps) => svg(p, <>
  <rect x="4" y="7.5" width="16" height="11.5" rx="3.6" />
  <path d="M12 7.5V4.4M9.6 4.4h4.8" />
  <circle cx="9" cy="12.8" r="1.05" fill="currentColor" stroke="none" />
  <circle cx="15" cy="12.8" r="1.05" fill="currentColor" stroke="none" />
  <path d="M9.6 16h4.8" />
</>);

export const IconSparkle = (p: IconProps) => svg(p, <>
  <path d="M12 3.2 13.6 8.4 18.8 10 13.6 11.6 12 16.8 10.4 11.6 5.2 10 10.4 8.4 12 3.2Z" />
  <path d="M18.4 16.2l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z" />
</>);

/** 心跳任务：心电波形 */
export const IconPulse = (p: IconProps) => svg(p, <>
  <path d="M3.5 12h3.4l2.1-5.6 3.6 10.4 2.3-7 1.4 2.2h4.2" />
</>);

/** 运行轨迹：分叉路径 */
export const IconRoute = (p: IconProps) => svg(p, <>
  <circle cx="6" cy="18.5" r="2" />
  <circle cx="18" cy="5.5" r="2" />
  <path d="M8 18.5h6.5a3.5 3.5 0 0 0 0-7H9a3 3 0 0 1 0-6h7" />
</>);

export const IconMemory = (p: IconProps) => svg(p, <>
  <path d="M8.6 5.4a3.5 3.5 0 0 1 6.8 0c1.8.45 3 1.95 3 3.8 0 .8-.2 1.5-.6 2.1.9.8 1.4 1.9 1.4 3.1 0 2.3-1.9 4.15-4.2 4.15-.6 1.3-1.9 2.25-3.6 2.25s-3-.9-3.6-2.25A4.2 4.2 0 0 1 3.7 14.4c0-1.2.5-2.3 1.4-3.1a3.9 3.9 0 0 1-.6-2.1c0-1.85 1.2-3.35 3-3.8Z" />
  <path d="M12 7v13" />
</>);

export const IconSkill = (p: IconProps) => svg(p, <>
  <path d="m13.2 3-8.2 10.2h5.4L10.8 21 19 10.8h-5.4L13.2 3Z" />
</>);

export const IconFolder = (p: IconProps) => svg(p, <>
  <path d="M3.8 7.2A1.7 1.7 0 0 1 5.5 5.5h3.6l1.9 2.3h7.5a1.7 1.7 0 0 1 1.7 1.7v8.3a1.7 1.7 0 0 1-1.7 1.7H5.5a1.7 1.7 0 0 1-1.7-1.7V7.2Z" />
</>);

export const IconFile = (p: IconProps) => svg(p, <>
  <path d="M6.5 3.5h7L18.5 8.4V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
  <path d="M13.3 3.6v4.9h5" />
</>);

export const IconDoc = (p: IconProps) => svg(p, <>
  <path d="M6.5 3.5h7L18.5 8.4V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
  <path d="M13.3 3.6v4.9h5M9 12.6h6M9 15.8h4.2" />
</>);

export const IconGear = (p: IconProps) => svg(p, <>
  <circle cx="12" cy="12" r="2.9" />
  <path d="M12 3.6v2.3M12 18.1v2.3M3.6 12h2.3M18.1 12h2.3M6.1 6.1l1.6 1.6M16.3 16.3l1.6 1.6M6.1 17.9l1.6-1.6M16.3 7.7l1.6-1.6" />
</>);

export const IconInbox = (p: IconProps) => svg(p, <>
  <path d="M4 13.4 6 6.2A1.6 1.6 0 0 1 7.5 5h9A1.6 1.6 0 0 1 18 6.2l2 7.2V18a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18v-4.6Z" />
  <path d="M4 13.4h4.4l1 2h5.2l1-2H20" />
</>);

export const IconAnswer = (p: IconProps) => svg(p, <>
  <path d="M4 7.2A3 3 0 0 1 7 4.2h10a3 3 0 0 1 3 3v5.9a3 3 0 0 1-3 3h-3.8L9 19.4v-3.3H7a3 3 0 0 1-3-3V7.2Z" />
  <path d="M8.6 10.2h6.8" />
</>);

export const IconChat = (p: IconProps) => svg(p, <>
  <path d="M4 6.6A2.6 2.6 0 0 1 6.6 4h10.8A2.6 2.6 0 0 1 20 6.6v7.8a2.6 2.6 0 0 1-2.6 2.6H9.2l-4.3 3.2c-.4.3-.9 0-.9-.5V6.6Z" />
  <path d="M8.4 9.4h7.2M8.4 12.6h4.6" />
</>);

export const IconActivity = (p: IconProps) => svg(p, <>
  <path d="M3.4 12h4l2.5-6.6L14 18.4l2.5-6.4h4.1" />
</>);

export const IconClock = (p: IconProps) => svg(p, <>
  <circle cx="12" cy="12" r="8.2" />
  <path d="M12 7.4V12l3.1 2" />
</>);

export const IconQuadrant = (p: IconProps) => svg(p, <>
  <rect x="4" y="4" width="16" height="16" rx="2.4" />
  <path d="M12 4v16M4 12h16" />
</>);

export const IconLink = (p: IconProps) => svg(p, <>
  <path d="M10 14.2 14.2 10" />
  <path d="M8.6 12 6 14.6a3.5 3.5 0 0 0 4.95 4.95L13.5 17M15.4 12 18 9.4a3.5 3.5 0 0 0-4.95-4.95L10.5 7" />
</>);

export const IconArrowRight = (p: IconProps) => svg(p, <>
  <path d="M5 12h13.5M13 6.5 18.5 12 13 17.5" />
</>);

export const IconArrowLeft = (p: IconProps) => svg(p, <>
  <path d="M19 12H5.5M11 6.5 5.5 12 11 17.5" />
</>);

export const IconChevronDown = (p: IconProps) => svg(p, <>
  <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
</>);

export const IconCheck = (p: IconProps) => svg(p, <>
  <path d="m5 12.8 4.6 4.4L19 6.8" />
</>);

export const IconClose = (p: IconProps) => svg(p, <>
  <path d="M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6" />
</>);

export const IconPlus = (p: IconProps) => svg(p, <>
  <path d="M12 5.4v13.2M5.4 12h13.2" />
</>);

export const IconSearch = (p: IconProps) => svg(p, <>
  <circle cx="11" cy="11" r="6.4" />
  <path d="m15.8 15.8 4 4" />
</>);

export const IconSend = (p: IconProps) => svg(p, <>
  <path d="M20.2 4 3.9 10.9l6.3 2.6 2.6 6.3L20.2 4Z" />
  <path d="M10.2 13.5 20.2 4" />
</>);

export const IconLogout = (p: IconProps) => svg(p, <>
  <path d="M14.5 5.5h3.2a1.8 1.8 0 0 1 1.8 1.8v9.4a1.8 1.8 0 0 1-1.8 1.8h-3.2" />
  <path d="M10.5 8.5 7 12l3.5 3.5M7 12h8" />
</>);

export const IconSwap = (p: IconProps) => svg(p, <>
  <path d="M4.5 8.5h13L14 5M19.5 15.5h-13L10 19" />
</>);

export const IconInfo = (p: IconProps) => svg(p, <>
  <circle cx="12" cy="12" r="8.4" />
  <path d="M12 11.2v5.2" />
  <circle cx="12" cy="8.2" r="0.95" fill="currentColor" stroke="none" />
</>);

export const IconTerminal = (p: IconProps) => svg(p, <>
  <rect x="3.5" y="4.5" width="17" height="15" rx="2.6" />
  <path d="m7.8 10 2.4 2.2-2.4 2.2M12.8 14.6h3.6" />
</>);

export const IconTrend = (p: IconProps) => svg(p, <>
  <path d="M4 17.5 9.2 11l3.6 3 5.6-7.2" />
  <path d="M14.4 6.8h4v4" />
</>);

export const IconEye = (p: IconProps) => svg(p, <>
  <path d="M2.8 12S6.4 5.8 12 5.8 21.2 12 21.2 12 17.6 18.2 12 18.2 2.8 12 2.8 12Z" />
  <circle cx="12" cy="12" r="2.9" />
</>);

export const IconTrash = (p: IconProps) => svg(p, <>
  <path d="M5 6.6h14M9.6 6.6V4.9a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v1.7M6.9 6.6l.8 12.6a1.5 1.5 0 0 0 1.5 1.4h5.6a1.5 1.5 0 0 0 1.5-1.4l.8-12.6" />
</>);

export const IconEdit = (p: IconProps) => svg(p, <>
  <path d="M14.6 5.4l4 4L9 19H5v-4l9.6-9.6Z" />
  <path d="m13 7 4 4" />
</>);

export const IconLock = (p: IconProps) => svg(p, <>
  <rect x="4.8" y="10.4" width="14.4" height="9.6" rx="2.4" />
  <path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4" />
</>);

export const IconShield = (p: IconProps) => svg(p, <>
  <path d="M12 3.4l7 2.6v5.6c0 4-2.9 7.3-7 8.9-4.1-1.6-7-4.9-7-8.9V6l7-2.6Z" />
  <path d="m8.9 12.1 2.2 2.2 4-4.4" />
</>);

export const IconFolderOpen = (p: IconProps) => svg(p, <>
  <path d="M3.6 7.2a1.8 1.8 0 0 1 1.8-1.8h3.3l1.9 2.2h8a1.8 1.8 0 0 1 1.8 1.8v1.2H3.6V7.2Z" />
  <path d="M3.6 10.6h17.4l-1.6 7a1.8 1.8 0 0 1-1.75 1.4H5.4a1.8 1.8 0 0 1-1.8-1.8v-6.6Z" />
</>);

export const IconChevronRight = (p: IconProps) => svg(p, <>
  <path d="m9.6 6.4 5.6 5.6-5.6 5.6" />
</>);

export const IconDownload = (p: IconProps) => svg(p, <>
  <path d="M12 4.4v10.2m0 0 3.6-3.6M12 14.6 8.4 11" />
  <path d="M4.8 17.6v1.2a1.8 1.8 0 0 0 1.8 1.8h10.8a1.8 1.8 0 0 0 1.8-1.8v-1.2" />
</>);
