/**
 * HTTP Cookie 纯函数模块。
 *
 * 这里只做「解析请求 Cookie / 拼装响应 Set-Cookie」两件事，刻意不引入
 * express、crypto 等任何运行时依赖 —— 除了便于单测（可直接 import 而
 * 不必拉起 server.ts 背后的 opus 等原生模块），也让 Cookie 的
 * 序列化契约集中在一处、可被独立审查。
 *
 * 注意 Set-Cookie 的拼装**必须**返回数组：/api/public-config 会同时下发
 * 访客编号与设备标识两个 Cookie，若调用方对 response.setHeader("Set-Cookie", x)
 * 连续调用两次，后一次会覆盖前一次 —— 数组化是防覆盖的硬约束。
 */

/** 访客展示编号 Cookie 名。前端据此显示「第 N 位访客」。 */
export const VISITOR_NUMBER_COOKIE = "webspeak_visitor_number";

/** 设备标识 Cookie 名。值为 32 位十六进制串，用于派生稳定的 TURN userid。 */
export const WEBSPEAK_DEVICE_COOKIE = "webspeak_device_id";

/** 设备标识必须严格匹配的格式：32 位小写十六进制（16 字节）。 */
const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * 从请求 Cookie 头中解析访客编号。
 *
 * 仅在值可解析为**安全正整数**时返回该数字，其余（缺失、非数字、
 * 越界、非正数）一律返回 null。
 */
export function readVisitorNumberCookie(header: string | undefined): number | null {
  if (!header) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (name !== VISITOR_NUMBER_COOKIE) continue;
    const rawValue = entry.slice(separator + 1).trim();
    const number = Number.parseInt(rawValue, 10);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }
  return null;
}

/**
 * 从请求 Cookie 头中解析设备标识。
 *
 * 值必须严格匹配 /^[0-9a-f]{32}$/；格式不合法或缺失一律返回 null，
 * 由调用方决定是否补发一个新设备 Cookie。
 */
export function readDeviceIdCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const name = entry.slice(0, separator).trim();
    if (name !== WEBSPEAK_DEVICE_COOKIE) continue;
    const rawValue = entry.slice(separator + 1).trim();
    return DEVICE_ID_PATTERN.test(rawValue) ? rawValue : null;
  }
  return null;
}

/**
 * 收集本次 /api/public-config 需要下发的 Set-Cookie 字符串。
 *
 * 只对**新分配**的值下发（params 传 null/undefined 表示沿用请求里已有的值，
 * 无需重复 Set-Cookie）。返回长度为 0~2 的数组，调用方应整体交给
 * response.setHeader("Set-Cookie", cookies)，避免逐条 setHeader 相互覆盖。
 */
export function collectPublicConfigCookies(params: {
  visitorNumber?: number | null;
  deviceId?: string | null;
  secure?: boolean;
}): string[] {
  const cookies: string[] = [];
  if (params.visitorNumber != null) {
    cookies.push(
      `${VISITOR_NUMBER_COOKIE}=${params.visitorNumber}; Max-Age=31536000; Path=/; SameSite=Lax${params.secure ? "; Secure" : ""}`,
    );
  }
  if (params.deviceId != null) {
    cookies.push(
      `${WEBSPEAK_DEVICE_COOKIE}=${params.deviceId}; Max-Age=31536000; Path=/; SameSite=Lax${params.secure ? "; Secure" : ""}`,
    );
  }
  return cookies;
}
