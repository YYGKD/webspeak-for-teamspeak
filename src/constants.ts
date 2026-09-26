/** The HTTP port is part of the WebSpeak deployment contract. */
export const APP_PORT = 3040;

/** Hard safety ceiling for independently connected browser sessions. */
export const MAX_ACTIVE_SESSIONS = 100;

export function canAcceptSession(activeSessionCount: number): boolean {
  return Number.isInteger(activeSessionCount) && activeSessionCount >= 0 && activeSessionCount < MAX_ACTIVE_SESSIONS;
}

/**
 * 单条屏幕共享流的 Web 观众软上限。
 *
 * 每位观众会在发起端 Router 与自身 Router 之间建立 1–2 对 PipeTransport 端点
 * 与 1–2 个 PipeProducer，规模随观众数线性放大，故设置软上限并在超限时拒绝
 * （返回 `SCREEN_SHARE_VIEWER_LIMIT_REACHED`）。集中在此便于调参。
 */
export const SCREEN_SHARE_MAX_WEB_VIEWERS = 32;
