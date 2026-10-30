import type { Env } from "./types";
import { ensureSchema, getAvConfig, createAvSession, getAvSession, deleteAvSession, type AvConfig } from "./db";
import { randomToken } from "./utils";

// ── ASIN extraction ───────────────────────────────────────────────────────────

export function extractAsin(input: string): string | null {
  const trimmed = input.trim();
  const byPath = trimmed.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (byPath) return byPath[1]!.toUpperCase();
  const plain = trimmed.match(/^([A-Z0-9]{10})$/i);
  if (plain) return plain[1]!.toUpperCase();
  return null;
}

// ── Product fetch ─────────────────────────────────────────────────────────────

interface ProductVariant {
  title: string;
  asin: string;
  priceJpy: number;
}

interface ProductInfo {
  title: string;
  asin: string;
  mainPriceJpy: number;
  imageUrl: string | null;
  variants: ProductVariant[];
}

async function fetchRainforest(apiKey: string, asin: string): Promise<ProductInfo> {
  const url = `https://api.rainforestapi.com/request?api_key=${encodeURIComponent(apiKey)}&type=product&asin=${encodeURIComponent(asin)}&amazon_domain=amazon.co.jp`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Rainforest API ${res.status}`);
  const data = await res.json() as any;
  const p = data?.product;
  const priceJpy = Number(p?.buybox_winner?.price?.value ?? p?.price?.value ?? 0);
  const variants: ProductVariant[] = (p?.variants ?? [])
    .slice(0, 10)
    .map((v: any) => ({
      title: String(v?.title ?? v?.asin ?? ""),
      asin: String(v?.asin ?? ""),
      priceJpy: Number(v?.price?.value ?? 0),
    }))
    .filter((v: ProductVariant) => v.asin && v.priceJpy > 0);
  return {
    title: String(p?.title ?? ""),
    asin,
    mainPriceJpy: priceJpy,
    imageUrl: p?.main_image?.link ?? null,
    variants,
  };
}

async function fetchKeepa(apiKey: string, asin: string): Promise<ProductInfo> {
  const url = `https://api.keepa.com/product?key=${encodeURIComponent(apiKey)}&domain=5&asin=${encodeURIComponent(asin)}&stats=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Keepa API ${res.status}`);
  const data = await res.json() as any;
  const p = data?.products?.[0];
  const rawPrice = p?.stats?.current?.[0];
  const priceJpy = rawPrice != null && rawPrice > 0 ? rawPrice / 100 : 0;
  return {
    title: String(p?.title ?? ""),
    asin,
    mainPriceJpy: priceJpy,
    imageUrl: null,
    variants: [],
  };
}

async function fetchCanopy(apiKey: string, asin: string): Promise<ProductInfo> {
  const url = `https://api.canopyapi.co/v1/amazon/products/${encodeURIComponent(asin)}`;
  const res = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  if (!res.ok) throw new Error(`Canopy API ${res.status}`);
  const data = await res.json() as any;
  const priceJpy = Number(data?.price ?? 0);
  return {
    title: String(data?.title ?? ""),
    asin,
    mainPriceJpy: priceJpy,
    imageUrl: data?.image ?? null,
    variants: [],
  };
}

export async function fetchProduct(cfg: AvConfig, asin: string): Promise<ProductInfo> {
  if (!cfg.api_key) throw new Error("APIキーが設定されていません");
  switch (cfg.api_type) {
    case "keepa": return fetchKeepa(cfg.api_key, asin);
    case "canopy": return fetchCanopy(cfg.api_key, asin);
    default: return fetchRainforest(cfg.api_key, asin);
  }
}

// ── LTC pricing ───────────────────────────────────────────────────────────────

export async function calcLtcAmount(jpy: number): Promise<number> {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=jpy");
  if (!res.ok) throw new Error("CoinGecko API error");
  const data = await res.json() as any;
  const ltcJpy = Number(data?.litecoin?.jpy ?? 0);
  if (!ltcJpy) throw new Error("LTCレートを取得できませんでした");
  return Math.round((jpy / 3 / ltcJpy) * 1e8) / 1e8;
}

// ── Interaction helpers ───────────────────────────────────────────────────────

function interactionResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

function ephemeral(content: string, components?: unknown[]): unknown {
  return { type: 4, data: { content, flags: 64, ...(components ? { components } : {}) } };
}

function deferEphemeral(): Response {
  return interactionResponse({ type: 5, data: { flags: 64 } });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleAvBuyButton(interaction: any, env: Env): Promise<Response> {
  const guildId = String(interaction.guild_id ?? "");
  await ensureSchema(env);
  const cfg = await getAvConfig(env, guildId);
  if (!cfg.ltc_address) {
    return interactionResponse(ephemeral("LTCアドレスが設定されていません。管理サイトで設定してください。"));
  }
  return interactionResponse({
    type: 9,
    data: {
      custom_id: `av:url_modal:${guildId}`,
      title: "Amazon商品URLを入力",
      components: [{
        type: 1,
        components: [{
          type: 4,
          custom_id: "url",
          style: 1,
          label: "AmazonのURLまたはASIN",
          placeholder: "https://www.amazon.co.jp/dp/XXXXXXXXXX または XXXXXXXXXX",
          required: true,
          min_length: 10,
          max_length: 200,
        }],
      }],
    },
  });
}

export async function handleAvUrlModal(interaction: any, env: Env, ctx: ExecutionContext): Promise<Response> {
  const guildId = String(interaction.guild_id ?? "");
  const userId = String(interaction.member?.user?.id ?? "");
  const rawUrl = String(interaction.data?.components?.[0]?.components?.[0]?.value ?? "").trim();
  const asin = extractAsin(rawUrl);
  if (!asin) {
    return interactionResponse(ephemeral("AmazonのURLまたはASINが正しくありません。"));
  }

  await ensureSchema(env);
  const cfg = await getAvConfig(env, guildId);
  if (!cfg.api_key) {
    return interactionResponse(ephemeral("APIキーが設定されていません。管理サイトで設定してください。"));
  }

  const sessionId = randomToken(16);
  const deferredRes = deferEphemeral();

  ctx.waitUntil((async () => {
    const appId = env.DISCORD_APPLICATION_ID;
    const token = String(interaction.token ?? "");
    try {
      const product = await fetchProduct(cfg, asin);
      if (!product.title) {
        await patchInteraction(appId, token, { content: "商品情報を取得できませんでした。URLを確認してください。", components: [] });
        return;
      }

      await createAvSession(env, {
        id: sessionId,
        guild_id: guildId,
        user_id: userId,
        asin,
        product_json: JSON.stringify(product),
        created_at: Date.now(),
      });

      if (product.variants.length > 0) {
        const options = product.variants.slice(0, 25).map((v, i) => ({
          label: v.title.slice(0, 100) || `オプション${i + 1}`,
          value: `${sessionId}:${v.asin}:${v.priceJpy}`,
          description: `¥${v.priceJpy.toLocaleString("ja-JP")}`,
        }));
        await patchInteraction(appId, token, {
          content: `**${product.title.slice(0, 200)}**\n\nバリエーションを選択してください:`,
          flags: 64,
          components: [{
            type: 1,
            components: [{
              type: 3,
              custom_id: `av:select:${sessionId}`,
              options,
              placeholder: "バリエーションを選択",
              min_values: 1,
              max_values: 1,
            }],
          }],
        });
      } else {
        const ltcAmount = await calcLtcAmount(product.mainPriceJpy);
        await deleteAvSession(env, sessionId);
        const cfg2 = await getAvConfig(env, guildId);
        await patchInteraction(appId, token, buildPaymentMessage(product.title, product.mainPriceJpy, ltcAmount, cfg2.ltc_address!, product.imageUrl));
      }
    } catch (err) {
      console.error("av:url_modal deferred error", err);
      await patchInteraction(appId, token, { content: "商品情報の取得中にエラーが発生しました。しばらくしてもう一度お試しください。", components: [] }).catch(() => {});
    }
  })());

  return deferredRes;
}

export async function handleAvSelect(interaction: any, env: Env): Promise<Response> {
  const value = String(interaction.data?.values?.[0] ?? "");
  const parts = value.split(":");
  if (parts.length < 3) return interactionResponse(ephemeral("選択値が不正です。"));
  const [sessionId, variantAsin, priceStr] = parts as [string, string, string];
  const priceJpy = Number(priceStr);
  if (!priceJpy) return interactionResponse(ephemeral("価格情報が不正です。"));

  await ensureSchema(env);
  const session = await getAvSession(env, sessionId);
  const guildId = String(interaction.guild_id ?? "");
  const cfg = await getAvConfig(env, guildId);

  let title = `ASIN: ${variantAsin}`;
  if (session) {
    try {
      const product = JSON.parse(session.product_json) as any;
      const variant = (product.variants ?? []).find((v: any) => v.asin === variantAsin);
      if (variant?.title) title = variant.title;
    } catch { /* ignore */ }
    await deleteAvSession(env, sessionId);
  }

  const ltcAmount = await calcLtcAmount(priceJpy);
  return interactionResponse({
    type: 7,
    data: buildPaymentMessage(title, priceJpy, ltcAmount, cfg.ltc_address ?? "", null),
  });
}

function buildPaymentMessage(title: string, priceJpy: number, ltcAmount: number, ltcAddress: string, imageUrl: string | null): unknown {
  return {
    content: "",
    flags: 64,
    components: [],
    embeds: [{
      title: "お支払い情報",
      description: `**${title.slice(0, 200)}**\n\nAmazon価格の1/3をLTCでお支払いください。`,
      color: 0xbfb78f,
      fields: [
        { name: "Amazon価格", value: `¥${priceJpy.toLocaleString("ja-JP")}`, inline: true },
        { name: "請求額 (1/3)", value: `${ltcAmount} LTC`, inline: true },
        { name: "送金先LTCアドレス", value: `\`${ltcAddress}\`` },
      ],
      ...(imageUrl ? { thumbnail: { url: imageUrl } } : {}),
      footer: { text: "支払い確認後に商品を発送します" },
    }],
  };
}

async function patchInteraction(appId: string, token: string, data: unknown): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${encodeURIComponent(appId)}/${encodeURIComponent(token)}/messages/@original`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Discord patch ${res.status}: ${await res.text()}`);
}
