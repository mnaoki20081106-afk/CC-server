import type { Env } from "./types";

function hexToU8(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

export async function verifyInteraction(env: Env, request: Request, body: string): Promise<boolean> {
  try {
    const sig = request.headers.get("X-Signature-Ed25519");
    const ts = request.headers.get("X-Signature-Timestamp");
    if (!sig || !ts) return false;
    const key = await crypto.subtle.importKey(
      "raw", hexToU8(env.DISCORD_PUBLIC_KEY),
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
      false, ["verify"]
    );
    return crypto.subtle.verify(
      "NODE-ED25519", key, hexToU8(sig),
      new TextEncoder().encode(ts + body)
    );
  } catch {
    return false;
  }
}

export class DiscordApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function botFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function botJson<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await botFetch(env, path, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new DiscordApiError(res.status, `Discord API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
}
