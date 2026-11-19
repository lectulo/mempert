import type { ServerWebSocket } from "bun";
import type { Meme } from "./db";
import type { Env } from "./env";
import { verifyQuery } from "./media";

export type LiveEvent =
  | { t: "meme"; id: string; status: Meme["status"]; title?: string | null }
  | { t: "job"; kind: "zip" | "export" | "batch" | "analysis" | "e621" };
export type LiveSocketData = { userId: string };

/** One process, at most ten users: no broker or persistent socket state needed. */
export class LiveHub {
  private sockets = new Set<ServerWebSocket<LiveSocketData>>();
  open(ws: ServerWebSocket<LiveSocketData>) { this.sockets.add(ws); }
  close(ws: ServerWebSocket<LiveSocketData>) { this.sockets.delete(ws); }
  send(userId: string, message: string) {
    for (const ws of this.sockets) if (ws.data.userId === userId) {
      try { ws.send(message); } catch { this.sockets.delete(ws); }
    }
  }
  stop() { for (const ws of this.sockets) ws.close(1001, "Server shutting down"); this.sockets.clear(); }
}

export const push = async (env: Env, userId: number, e: LiveEvent) => {
  try { env.LIVE.send(String(userId), JSON.stringify(e)); } catch { /* notifications are best effort */ }
};

export async function liveUser(req: Request, env: Env, url = new URL(req.url)) {
  const id = url.pathname.split("/")[3] ?? "";
  return /^\d+$/.test(id) && await verifyQuery(env, `live|${id}`, url) ? id : null;
}

/** The actual upgrade is performed by Bun.serve, after checking the same signed ticket. */
export async function handleLive(req: Request, env: Env, url: URL) {
  if (!await liveUser(req, env, url)) return new Response("Forbidden", { status: 403 });
  return new Response("Upgrade Required", { status: 426 });
}
