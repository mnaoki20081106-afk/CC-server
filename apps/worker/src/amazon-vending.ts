import type { Env } from "./types";
import { ensureSchema, getAvConfig, createAvSession, getAvSession, deleteAvSession, getGuildConfig, type AvConfig } from "./db";
import { randomToken } from "./utils";
import { botJson } from "./discord";

// ── ASIN extraction ───────────────────────────────────────────────────────────

export function extractAsin(input: string): string | null {
  const trimmed = input.trim();
  const byPath = trimmed.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (byPath) return byPath[1]!.toUpperCase();
  const plain = trimmed.match(/^([A-Z0-9]{10})$/i);
  if (plain) return plain[1]!.toUpperCase();
  return null;
}

// ── Lawson verification (Google Places API) ───────────────────────────────────

async function verifyLawsonAddress(env: Env, address: string): Promise<{ found: boolean; storeName: string | null }> {
  if (!env.GOOGLE_PLACES_API_KEY) throw new Error("GOOGLE_PLACES_API_KEY not configured");
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({
      textQuery: `ローソン ${address}`,
      languageCode: "ja",
      maxResultCount: 3,
      includedType: "convenience_store",
    }),
  });
  if (!res.ok) throw new Error(`Places API ${res.status}`);
  const data = await res.json() as any;
  const places: any[] = data?.places ?? [];
  const lawson = places.find(p => /ローソン|LAWSON/i.test(String(p?.displayName?.text ?? "")));
  if (!lawson) return { found: false, storeName: null };
  return { found: true, storeName: String(lawson.displayName.text) };
}

// ── Pickup number generation ──────────────────────────────────────────────────

function genPickupNumbers(): { inquiry: string; confirmation: string } {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  // 12 digits: first 5 bytes as BigInt, mod 10^12
  const n = BigInt(buf[0]!) * 4294967296n
           + BigInt(buf[1]!) * 16777216n
           + BigInt(buf[2]!) * 65536n
           + BigInt(buf[3]!) * 256n
           + BigInt(buf[4]!);
  const inquiry = (n % 1_000_000_000_000n).toString().padStart(12, "0");
  // 7 digits: next 3 bytes, mod 10^7
  const m = BigInt(buf[5]!) * 65536n + BigInt(buf[6]!) * 256n + BigInt(buf[7]!);
  const confirmation = (m % 10_000_000n).toString().padStart(7, "0");
  return { inquiry, confirmation };
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

// ── Ticket channel ────────────────────────────────────────────────────────────

async function createTicketChannel(
  env: Env,
  guildId: string,
  userId: string,
  username: string,
  productTitle: string,
  priceJpy: number,
  ltcAmount: number,
  storeName: string,
  inquiry: string,
  confirmation: string,
): Promise<void> {
  const guildCfg = await getGuildConfig(env, guildId);

  const allow = "68608"; // VIEW_CHANNEL(1024) | SEND_MESSAGES(2048) | READ_MESSAGE_HISTORY(65536)
  const deny = "1024";

  const overwrites: any[] = [
    { id: guildId, type: 0, deny },
    { id: userId, type: 1, allow },
  ];
  if (guildCfg.admin_role_id) overwrites.push({ id: String(guildCfg.admin_role_id), type: 0, allow });
  if (guildCfg.mod_role_id) overwrites.push({ id: String(guildCfg.mod_role_id), type: 0, allow });

  const safeName = username.replace(/[^a-z0-9_-]/gi, "-").toLowerCase().slice(0, 20);
  const channelPayload: any = {
    name: `av-${safeName}-${Date.now().toString(36)}`.slice(0, 100),
    type: 0,
    permission_overwrites: overwrites,
  };
  if (guildCfg.ticket_category_id) channelPayload.parent_id = String(guildCfg.ticket_category_id);

  const channel = await botJson<{ id: string }>(env, `/guilds/${guildId}/channels`, {
    method: "POST",
    body: JSON.stringify(channelPayload),
  });

  await botJson(env, `/channels/${channel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: `<@${userId}> ご注文ありがとうございます！`,
      embeds: [{
        title: "🛒 ご注文情報",
        color: 0xff9900,
        fields: [
          { name: "商品", value: productTitle.slice(0, 1024), inline: false },
          { name: "Amazon価格", value: `¥${priceJpy.toLocaleString("ja-JP")}`, inline: true },
          { name: "請求額（LTC）", value: `${ltcAmount} LTC`, inline: true },
          { name: "お受け取り店舗", value: storeName, inline: false },
          { name: "📦 お問い合わせ番号", value: `\`${inquiry}\``, inline: true },
          { name: "🔑 確認番号", value: `\`${confirmation}\``, inline: true },
        ],
        footer: { text: "LTC送金確認後にスタッフが商品手配を開始します。" },
      }],
    }),
  });
}

// ── Address modal (shared) ────────────────────────────────────────────────────

function addressModalData(customId: string): unknown {
  return {
    custom_id: customId,
    title: "お届け先を入力（ローソン）",
    components: [{
      type: 1,
      components: [{
        type: 4,
        custom_id: "address",
        style: 2,
        label: "ローソンの店舗名・住所",
        placeholder: "例：ローソン 渋谷道玄坂店\n東京都渋谷区道玄坂2-25-12",
        required: true,
        min_length: 5,
        max_length: 300,
      }],
    }],
  };
}

// ── Interaction helpers ───────────────────────────────────────────────────────

function interactionResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

function ephemeral(content: string): unknown {
  return { type: 4, data: { content, flags: 64 } };
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
          content: "",
          flags: 64,
          embeds: [{
            title: product.title.slice(0, 256),
            description: "バリエーションを選択してください。",
            color: 0xff9900,
            ...(product.imageUrl ? { thumbnail: { url: product.imageUrl } } : {}),
          }],
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
        // No variants — show product info with "住所を入力" button
        await patchInteraction(appId, token, {
          content: "",
          flags: 64,
          embeds: [{
            title: product.title.slice(0, 256),
            color: 0xff9900,
            fields: [
              { name: "Amazon価格", value: `¥${product.mainPriceJpy.toLocaleString("ja-JP")}`, inline: true },
            ],
            ...(product.imageUrl ? { thumbnail: { url: product.imageUrl } } : {}),
          }],
          components: [{
            type: 1,
            components: [{
              type: 2,
              custom_id: `av:next:${sessionId}`,
              label: "お届け先を入力",
              style: 1,
              emoji: { name: "📦" },
            }],
          }],
        });
      }
    } catch (err) {
      console.error("av:url_modal deferred error", err);
      await patchInteraction(appId, token, { content: "商品情報の取得中にエラーが発生しました。しばらくしてもう一度お試しください。", components: [] }).catch(() => {});
    }
  })());

  return deferredRes;
}

// Called when user clicks "お届け先を入力" button after no-variant product fetch
export function handleAvNext(interaction: any): Response {
  const sessionId = String(interaction.data?.custom_id ?? "").split(":")[2] ?? "";
  return interactionResponse({
    type: 9,
    data: addressModalData(`av:addr_modal:${sessionId}`),
  });
}

// Called when user selects a variant — returns address modal directly
export async function handleAvSelect(interaction: any, env: Env): Promise<Response> {
  const value = String(interaction.data?.values?.[0] ?? "");
  const parts = value.split(":");
  if (parts.length < 3) return interactionResponse(ephemeral("選択値が不正です。"));
  const [sessionId, variantAsin, priceStr] = parts as [string, string, string];
  if (!Number(priceStr)) return interactionResponse(ephemeral("価格情報が不正です。"));

  // Session stays alive until address modal completes
  return interactionResponse({
    type: 9,
    data: addressModalData(`av:addr_modal:${sessionId}:${variantAsin}:${priceStr}`),
  });
}

// Final step: address modal submit — verify Lawson, create ticket channel, return payment embed
export async function handleAvAddrModal(interaction: any, env: Env, ctx: ExecutionContext): Promise<Response> {
  const customId = String(interaction.data?.custom_id ?? "");
  const parts = customId.split(":");
  const sessionId = parts[2] ?? "";
  const variantAsin = parts[3] ?? null;
  const variantPriceJpy = parts[4] ? Number(parts[4]) : null;

  const address = String(
    (interaction.data?.components as any[] | undefined)?.[0]?.components?.[0]?.value ?? ""
  ).trim();

  await ensureSchema(env);
  const session = await getAvSession(env, sessionId);
  if (!session) return interactionResponse(ephemeral("セッションが切れました。もう一度最初からお試しください。"));

  const guildId = String(interaction.guild_id ?? "");
  const userId = String(interaction.member?.user?.id ?? "");
  const username = String(interaction.member?.user?.username ?? "user");

  // Verify Lawson store via Google Places, fallback to regex if API unavailable
  let storeName: string | null = null;
  try {
    const result = await verifyLawsonAddress(env, address);
    if (!result.found) {
      return interactionResponse(ephemeral(
        "⚠️ このローソン店舗を見つけられませんでした。\n店舗名と住所を正確に入力してください。\n\n例：`ローソン 渋谷道玄坂店 東京都渋谷区道玄坂2-25-12`"
      ));
    }
    storeName = result.storeName;
  } catch (err) {
    console.error("Places API error, falling back to regex", err);
    const m = address.match(/ローソン[぀-ゟ゠-ヿ一-鿿\w\s　（）()A-Za-z0-9０-９]*?店/);
    if (!m) {
      return interactionResponse(ephemeral(
        "⚠️ お届け先はローソン店舗のみ対応しています。\nローソンの店舗名と住所を入力してください。"
      ));
    }
    storeName = m[0].trim();
  }

  // Resolve product title and price from session
  let title: string;
  let priceJpy: number;
  let imageUrl: string | null = null;
  try {
    const product = JSON.parse(session.product_json) as any;
    imageUrl = product.imageUrl ?? null;
    if (variantAsin && variantPriceJpy) {
      const variant = (product.variants ?? []).find((v: any) => v.asin === variantAsin);
      title = String(variant?.title || `ASIN: ${variantAsin}`);
      priceJpy = variantPriceJpy;
    } else {
      title = String(product.title ?? session.asin);
      priceJpy = Number(product.mainPriceJpy ?? 0);
    }
  } catch {
    return interactionResponse(ephemeral("商品情報の読み込みに失敗しました。"));
  }

  const cfg = await getAvConfig(env, guildId);
  const ltcAmount = await calcLtcAmount(priceJpy);
  const { inquiry, confirmation } = genPickupNumbers();
  const finalStoreName = storeName ?? address;

  ctx.waitUntil(
    Promise.all([
      createTicketChannel(env, guildId, userId, username, title, priceJpy, ltcAmount, finalStoreName, inquiry, confirmation),
      deleteAvSession(env, sessionId),
    ]).catch(err => console.error("av ticket channel error", err))
  );

  return interactionResponse({
    type: 4,
    data: buildPaymentMessage(title, priceJpy, ltcAmount, cfg.ltc_address ?? "", imageUrl, finalStoreName),
  });
}

function buildPaymentMessage(
  title: string,
  priceJpy: number,
  ltcAmount: number,
  ltcAddress: string,
  imageUrl: string | null,
  storeName: string,
): unknown {
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
        { name: "お受け取り店舗", value: storeName, inline: false },
        { name: "送金先LTCアドレス", value: `\`${ltcAddress}\`` },
      ],
      ...(imageUrl ? { thumbnail: { url: imageUrl } } : {}),
      footer: { text: "送金後、スタッフがチャンネルにてご連絡します" },
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
