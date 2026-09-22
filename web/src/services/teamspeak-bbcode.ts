/**
 * TeamSpeak 频道说明的富文本渲染。
 *
 * 说明字段是 BBCode 富文本（原生客户端会渲染颜色/粗体/链接）。这里只渲染一个安全子集：
 *   [B] [I] [U] [S] [COLOR=…] [URL]…[/URL] [URL=…]…[/URL]
 * 已知但不在子集里的标记（[SIZE] [FONT] [CENTER] [IMG] [LIST] …）只丢掉标记、保留文字；
 * 未知方括号原样保留——说明正文里经常有 [音乐名称] 这种普通文本，不能一刀切。
 *
 * 安全约定：整段文本先做 HTML 转义，之后只插入本文件自己生成的标签；颜色只接受
 * #hex 或少量命名色，链接只接受 http/https，其余情况一律降级为纯文字。
 * 不引入任何第三方 BBCode 库：子集足够小，且渲染结果要靠本地规则约束 XSS 面。
 */

const NAMED_COLORS = new Set([
  "red", "green", "blue", "orange", "yellow", "purple", "pink", "brown",
  "white", "black", "gray", "grey", "silver", "cyan", "aqua", "lime",
  "navy", "teal", "olive", "maroon", "magenta", "fuchsia",
]);

/** 渲染成真实样式的标记（成对使用；单侧出现时也按此包裹）。 */
const PAIRED_TAGS: Record<string, [string, string]> = {
  B: ["<strong>", "</strong>"],
  STRONG: ["<strong>", "</strong>"],
  I: ["<em>", "</em>"],
  EM: ["<em>", "</em>"],
  U: ["<u>", "</u>"],
  S: ["<s>", "</s>"],
  STRIKE: ["<s>", "</s>"],
};

/** 已知但本期不渲染的标记：仅丢弃标记本身，保留其文字内容。 */
const DROPPED_TAGS = new Set([
  "SIZE", "FONT", "CENTER", "LEFT", "RIGHT", "JUSTIFY", "LIST", "*",
  "IMG", "HR", "SPOILER", "CODE", "QUOTE", "TABLE", "TR", "TD",
  "SUB", "SUP", "EMAIL", "YOUTUBE", "VIDEO", "BANNER", "NOPARSE",
]);

const TAG_PATTERN = /^\[(\/)?([A-Za-z*][A-Za-z0-9*]*)(?:=([^\]]*))?\]$/;

interface Frame {
  name: string;
  /** 内容收集齐之后如何包裹（未识别的标记不会成为 Frame）。 */
  wrap: (inner: string) => string;
  parts: string[];
}

export function renderChannelDescription(raw: string): string {
  if (!raw) return "";
  const source = escapeHtml(raw);
  const root: Frame = { name: "", wrap: (inner) => inner, parts: [] };
  const stack: Frame[] = [root];
  const emit = (text: string): void => {
    stack[stack.length - 1]!.parts.push(text);
  };

  const tagPattern = /\[\/?[A-Za-z*][A-Za-z0-9*]*(?:=[^\]]*)?\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(source)) !== null) {
    emit(source.slice(cursor, match.index));
    cursor = tagPattern.lastIndex;
    const frame = frameForTag(match[0]);
    if (!frame) {
      // 未知方括号（例如 [音乐名称]）：原样保留。
      emit(match[0]);
      continue;
    }
    if (frame.open) stack.push(frame.open);
    else closeFrame(stack, frame.closeName, emit);
  }
  emit(source.slice(cursor));

  // 未闭合的标记：按"内容仍然有效"处理，从内向外补齐包裹。
  while (stack.length > 1) {
    const frame = stack.pop()!;
    stack[stack.length - 1]!.parts.push(frame.wrap(frame.parts.join("")));
  }
  return root.parts.join("");
}

function frameForTag(raw: string): { open?: Frame; closeName: string } | null {
  const parsed = TAG_PATTERN.exec(raw);
  if (!parsed) return null;
  const closing = parsed[1] === "/";
  const name = parsed[2]!.toUpperCase();
  const value = parsed[3];

  if (name === "URL") {
    if (closing) return { closeName: name };
    const href = value === undefined ? "" : normalizeHref(value);
    if (value !== undefined && !href) return { closeName: name, open: { name, wrap: (inner) => inner, parts: [] } };
    return {
      closeName: name,
      open: {
        name,
        // [URL]文字[/URL]：href 取内容本身（内容含生成标签时不当作链接）。
        wrap: (inner) => {
          const target = value === undefined ? normalizeHref(inner) : href;
          return target && !inner.includes("<") ? `<a href="${target}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
        },
        parts: [],
      },
    };
  }

  if (name === "COLOR") {
    if (closing) return { closeName: name };
    const color = value === undefined ? "" : normalizeColor(value);
    return { closeName: name, open: { name, wrap: color ? (inner) => `<span style="color:${color}">${inner}</span>` : (inner) => inner, parts: [] } };
  }

  const pair = PAIRED_TAGS[name];
  if (pair) {
    return closing ? { closeName: name } : { closeName: name, open: { name, wrap: (inner) => `${pair[0]}${inner}${pair[1]}`, parts: [] } };
  }

  if (DROPPED_TAGS.has(name)) return { closeName: name, open: closing ? undefined : { name, wrap: (inner) => inner, parts: [] } };
  return null;
}

function closeFrame(stack: Frame[], name: string, emit: (text: string) => void): void {
  const depth = stack.length;
  const fromTop = [...stack].reverse().findIndex((frame) => frame.name === name);
  if (fromTop < 0) return;
  const target = depth - 1 - fromTop;
  // 先关掉内层未闭合的标记，再关目标标记（与浏览器对 BBCode 的容错一致）。
  while (stack.length - 1 > target) {
    const inner = stack.pop()!;
    stack[stack.length - 1]!.parts.push(inner.wrap(inner.parts.join("")));
  }
  const frame = stack.pop()!;
  emit(frame.wrap(frame.parts.join("")));
}

function normalizeColor(value: string): string {
  const color = value.trim().toLocaleLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(color)) return color;
  return NAMED_COLORS.has(color) ? color : "";
}

function normalizeHref(value: string): string {
  const href = value.trim().replace(/&amp;/g, "&");
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(href)) return "";
  return escapeHtml(href);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
