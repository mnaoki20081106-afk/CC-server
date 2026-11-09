// Discord-Security を CC-server の Worker に統合するための接続層。
//
// Discord-Bot (Main) は本来、別Workerの Discord-Security へ HMAC 署名付きの
// 内部API (SECURITY_SERVICE / SECURITY_API_BASE_URL) で接続する設計になっている。
// CC-server では両者を 1 つの Worker にまとめるため、Main 側の security-bridge は
// そのままに、宛先を同じ Worker 内の Security ハンドラへ差し替える。
//
// - Security のコード (./security/*) は Discord-Security リポジトリのまま無改変。
// - Security の D1 は Main と分離した SECURITY_DB を使う (元設計の「別D1」を維持)。
// - Security 専用の Bot Token を使う場合は SECURITY_DISCORD_BOT_TOKEN /
//   SECURITY_DISCORD_APPLICATION_ID を設定する。未設定なら Main の Bot を共用する。
// - SECURITY_API_BASE_URL を設定した場合は、従来どおり外部の Discord-Security
//   Worker へ接続し、内蔵 Security は動かさない。

import securityWorker from "./security/index";
import { DiscordSecurityGateway as SecurityGatewayBase } from "./security/gateway";
import type { Env as SecurityEnv } from "./security/types";
import type { Env } from "./types";

const INTERNAL_SECURITY_ORIGIN = "https://cc-server-security.internal/";
const DERIVED_SECRET_LABEL = "cc-server:integrated-security-bridge:v1";

function externalSecurityConfigured(env: Env): boolean {
  return Boolean(env.SECURITY_API_BASE_URL?.trim());
}

export function integratedSecurityAvailable(env: Env): boolean {
  return Boolean(
    !externalSecurityConfigured(env) &&
    env.SECURITY_DB &&
    env.SECURITY_GATEWAY &&
    securityBotToken(env) &&
    securityApplicationId(env)
  );
}

function securityBotToken(env: Env): string {
  return (env.SECURITY_DISCORD_BOT_TOKEN?.trim() || env.DISCORD_BOT_TOKEN?.trim() || "");
}

function securityApplicationId(env: Env): string {
  return (
    env.SECURITY_DISCORD_APPLICATION_ID?.trim() ||
    env.DISCORD_APPLICATION_ID?.trim() ||
    ""
  );
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

const derivedSecrets = new Map<string, Promise<string>>();

/**
 * Main と Security の間の署名鍵。SECURITY_BRIDGE_SECRET が設定されていればそれを使い、
 * 無ければ Bot Token から HMAC で導出する (同一Worker内でしか使わないため、
 * 利用者に追加のSecret設定を求めない)。
 */
async function bridgeSecret(env: Env): Promise<string> {
  const configured = env.SECURITY_BRIDGE_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  const token = securityBotToken(env);
  let pending = derivedSecrets.get(token);
  if (!pending) {
    pending = (async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(token),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      return hex(await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(DERIVED_SECRET_LABEL)
      ));
    })();
    derivedSecrets.set(token, pending);
  }
  return pending;
}

function toSecurityEnv(env: Env, secret: string): SecurityEnv {
  return {
    DB: env.SECURITY_DB!,
    SECURITY_GATEWAY: env.SECURITY_GATEWAY!,
    DISCORD_BOT_TOKEN: securityBotToken(env),
    DISCORD_APPLICATION_ID: securityApplicationId(env),
    // Main Bot は Security に恒久ホワイトリストされない「管理対象サービスBot」として登録される。
    MAIN_BOT_APPLICATION_ID: env.DISCORD_APPLICATION_ID?.trim() || undefined,
    SECURITY_BRIDGE_SECRET: secret
  };
}

/**
 * Main 側の env に、同じ Worker 内の Security へ届く SECURITY_SERVICE を差し込む。
 * Main のコード (security-bridge.ts) からは別Workerへ接続しているのと同じに見える。
 */
export async function withIntegratedSecurity(env: Env, ctx: ExecutionContext): Promise<Env> {
  if (!integratedSecurityAvailable(env)) return env;
  const secret = await bridgeSecret(env);
  const securityEnv = toSecurityEnv(env, secret);
  const service = {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request && !init ? input : new Request(input as RequestInfo, init);
      return securityWorker.fetch(request as Request<unknown, IncomingRequestCfProperties>, securityEnv, ctx);
    },
    connect(): never {
      throw new Error("connect() is not supported by the integrated Security service");
    }
  } as unknown as Fetcher;
  return {
    ...env,
    SECURITY_API_BASE_URL: INTERNAL_SECURITY_ORIGIN,
    SECURITY_BRIDGE_SECRET: secret,
    SECURITY_SERVICE: service
  };
}

/** Discord-Security の Cron (監査ログ照合 / Gateway維持 / Lockdown自動解除)。 */
export async function securityScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  if (!integratedSecurityAvailable(env)) return;
  const secret = await bridgeSecret(env);
  await securityWorker.scheduled(controller, toSecurityEnv(env, secret), ctx);
}

/**
 * Security Gateway の Durable Object。ランタイムからは Worker 全体の env で
 * 生成されるため、Security 用の env に詰め替えて元のクラスへ渡す。
 * 署名鍵は Gateway 内では使われないため、ここでは同期的に渡せる値を設定する。
 */
export class DiscordSecurityGateway extends SecurityGatewayBase {
  constructor(state: DurableObjectState, env: Env) {
    super(state, toSecurityEnv(env, env.SECURITY_BRIDGE_SECRET?.trim() ?? ""));
  }
}
