"use client";

import type { SVGProps } from "react";

/**
 * One icon set for the whole app, replacing the emoji that were used as icons.
 * Emoji render differently on every OS, can't inherit color, and get read aloud
 * by screen readers as "shopping trolley" in the middle of a button label.
 *
 * Every icon is decorative by default (aria-hidden). If an icon is the only
 * content of a control, give the control an aria-label.
 */

export type IconName =
  | "register" | "clock" | "chart" | "bank" | "grid" | "store" | "star"
  | "contract" | "tent" | "users" | "link" | "settings" | "inbox" | "tag"
  | "search" | "plus" | "minus" | "close" | "check" | "checkCircle" | "alert"
  | "info" | "warning" | "chevronDown" | "chevronRight" | "chevronLeft"
  | "chevronUp" | "arrowLeft" | "arrowRight" | "sort" | "menu" | "more"
  | "trash" | "edit" | "print" | "download" | "refresh" | "external"
  | "mail" | "phone" | "calendar" | "card" | "cash" | "receipt" | "box"
  | "camera" | "image" | "lock" | "unlock" | "logout" | "user" | "bell"
  | "eye" | "copy" | "filter" | "sun" | "moon" | "scan" | "dollar"
  | "message" | "help" | "shield" | "clipboard";

type Props = SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
  /** Set a label to make the icon meaningful to assistive tech. */
  label?: string;
};

const P: Record<IconName, JSX.Element> = {
  register: <><rect x="2" y="7" width="20" height="13" rx="2" /><path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" /><path d="M6 12h4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  chart: <><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M7 15l3.5-4 3 2.5L20 7" /></>,
  bank: <><path d="M3 10h18" /><path d="M5 10v9M9 10v9M15 10v9M19 10v9" /><path d="M2 21h20" /><path d="M12 3 2.5 8h19L12 3Z" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  store: <><path d="M3 9.5 4.5 4h15L21 9.5" /><path d="M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /><path d="M5 12v8h14v-8" /></>,
  star: <><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.9L6.6 19.7l1-6L3.2 9.4l6.1-.9L12 3Z" /></>,
  contract: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>,
  tent: <><path d="M12 4 3 20h18L12 4Z" /><path d="M12 4v16" /><path d="m7.5 20 4.5-7 4.5 7" /></>,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16.5 5.3a3.2 3.2 0 0 1 0 5.4" /><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8" /></>,
  link: <><path d="M10 13a4 4 0 0 0 5.7.4l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" /><path d="M14 11a4 4 0 0 0-5.7-.4l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" /></>,
  inbox: <><path d="M3 12h5l2 3h4l2-3h5" /><path d="M5.5 5h13l2.5 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2.5-7Z" /></>,
  tag: <><path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h8l8.6 8.6a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  minus: <><path d="M5 12h14" /></>,
  close: <><path d="M18 6 6 18M6 6l12 12" /></>,
  check: <><path d="m20 6-11 11-5-5" /></>,
  checkCircle: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><circle cx="12" cy="16.3" r="1" fill="currentColor" stroke="none" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16.5V11" /><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none" /></>,
  warning: <><path d="M10.3 3.9 2 18.2A2 2 0 0 0 3.7 21h16.6a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4.5" /><circle cx="12" cy="17.2" r="1" fill="currentColor" stroke="none" /></>,
  chevronDown: <><path d="m6 9 6 6 6-6" /></>,
  chevronRight: <><path d="m9 6 6 6-6 6" /></>,
  chevronLeft: <><path d="m15 6-6 6 6 6" /></>,
  chevronUp: <><path d="m6 15 6-6 6 6" /></>,
  arrowLeft: <><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></>,
  arrowRight: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  sort: <><path d="m8 7 0 12" /><path d="m5 10 3-3 3 3" /><path d="m16 17 0-12" /><path d="m13 14 3 3 3-3" /></>,
  menu: <><path d="M3 6h18M3 12h18M3 18h18" /></>,
  more: <><circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" /><path d="M10 11v6M14 11v6" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" /></>,
  print: <><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M6 15h12v6H6z" /></>,
  download: <><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4 20h16" /></>,
  refresh: <><path d="M3.5 10a8.5 8.5 0 0 1 14.4-4.4L21 8.5" /><path d="M21 4v4.5h-4.5" /><path d="M20.5 14a8.5 8.5 0 0 1-14.4 4.4L3 15.5" /><path d="M3 20v-4.5h4.5" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  mail: <><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  phone: <><path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5L16 12l4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3.5 5.2 2 2 0 0 1 5.5 3Z" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M8 3v4M16 3v4" /></>,
  card: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 15h4" /></>,
  cash: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.6" /><path d="M6 12h.01M18 12h.01" /></>,
  receipt: <><path d="M5 3v18l2.5-1.5L10 21l2-1.5L14 21l2.5-1.5L19 21V3H5Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  box: <><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z" /><path d="m3 7 9 5 9-5" /><path d="M12 12v10" /></>,
  camera: <><path d="M4 8h3l1.5-2.5h7L17 8h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" /><circle cx="12" cy="13.5" r="3.5" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.5-2" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></>,
  bell: <><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z" /><path d="M10.3 19a2 2 0 0 0 3.4 0" /></>,
  eye: <><path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  filter: <><path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <><path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10Z" /></>,
  scan: <><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><path d="M4 12h16" /></>,
  dollar: <><path d="M12 2v20" /><path d="M17 6.5c0-2-2.2-3-5-3s-5 1-5 3.2S9 10 12 10.5s5 1.3 5 3.5-2.2 3.2-5 3.2-5-1-5-3" /></>,
  message: <><path d="M21 11.5a8 8 0 0 1-8.5 8 9 9 0 0 1-3.6-.7L3 21l1.4-4.2A8 8 0 0 1 12.5 3.5a8 8 0 0 1 8.5 8Z" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.2A2.6 2.6 0 0 1 14.5 10c0 1.7-2.5 2-2.5 3.5" /><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" /></>,
  shield: <><path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m9 12 2 2 4-4" /></>,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5H9V4Z" /><path d="M9 11h6M9 15h4" /></>,
};

export function Icon({ name, size = 16, label, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {label ? <title>{label}</title> : null}
      {P[name]}
    </svg>
  );
}

export default Icon;
