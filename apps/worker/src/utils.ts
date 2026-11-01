import type { Env } from "./types";

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

export function randomToken(n = 32): string {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.WEB_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export function json(body: unknown, init: ResponseInit & { env?: Env } = {}): Response {
  const { env, ...rest } = init;
  return new Response(JSON.stringify(body), {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(env ? corsHeaders(env) : {}),
      ...(rest.headers ?? {}),
    },
  });
}

