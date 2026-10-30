import { EmbedBuilder } from 'discord.js';

export interface VariantInfo {
  asin: string;
  label: string;
  price_jpy: number | null;
}

export interface ProductInfo {
  title: string;
  asin: string;
  price_jpy: number | null;
  variants: VariantInfo[];
}

export function extractAsin(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Z0-9]{10}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/(?:\/dp\/|\/gp\/product\/|\/product\/)([A-Z0-9]{10})/);
  return m ? m[1] : null;
}

async function fetchRainforest(asin: string, apiKey: string): Promise<ProductInfo | null> {
  const url = `https://api.rainforestapi.com/request?api_key=${apiKey}&type=product&asin=${asin}&amazon_domain=amazon.co.jp`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  const p = data.product;
  if (!p) return null;
  const price = p.buybox_winner?.price?.value ?? p.price?.value ?? null;
  const variants: VariantInfo[] = (p.variants ?? [])
    .filter((v: any) => v.asin)
    .map((v: any) => ({
      asin: v.asin as string,
      label:
        v.dimensions?.map((d: any) => `${d.name}: ${d.value}`).join(' / ') ??
        v.title ??
        v.asin,
      price_jpy: v.price?.value ?? null,
    }));
  return { title: p.title ?? asin, asin: p.asin ?? asin, price_jpy: price, variants };
}

async function fetchKeepa(asin: string, apiKey: string): Promise<ProductInfo | null> {
  const url = `https://api.keepa.com/product?key=${apiKey}&domain=5&asin=${asin}&stats=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  if (!data.products?.length) return null;
  const p = data.products[0];
  // Keepa stores prices as integer cents; -1 = N/A
  const raw = p.stats?.current?.[0] ?? -1;
  const price_jpy = raw > 0 ? raw / 100 : null;
  const variants: VariantInfo[] = (p.variations ?? []).map((v: any) => ({
    asin: v.asin as string,
    label:
      v.attributes?.map((a: any) => `${a.dimension}: ${a.value}`).join(' / ') ?? v.asin,
    price_jpy: null,
  }));
  return { title: p.title ?? asin, asin: p.asin ?? asin, price_jpy, variants };
}

async function fetchCanopy(asin: string, apiKey: string): Promise<ProductInfo | null> {
  const query = `{ product(input: { asin: "${asin}", domain: JP }) { title asin price { value } variants { asin title price { value } variationAttributes { name value } } } }`;
  const res = await fetch('https://graphql.canopyapi.co/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-KEY': apiKey },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  const p = data.data?.product;
  if (!p) return null;
  const variants: VariantInfo[] = (p.variants ?? []).map((v: any) => ({
    asin: v.asin as string,
    label:
      v.variationAttributes?.map((a: any) => `${a.name}: ${a.value}`).join(' / ') ??
      v.title ??
      v.asin,
    price_jpy: v.price?.value ?? null,
  }));
  return {
    title: p.title ?? asin,
    asin: p.asin ?? asin,
    price_jpy: p.price?.value ?? null,
    variants,
  };
}

export async function fetchProduct(
  asin: string,
  apiType: string,
  apiKey: string,
): Promise<ProductInfo | null> {
  switch (apiType) {
    case 'keepa':
      return fetchKeepa(asin, apiKey);
    case 'canopy':
      return fetchCanopy(asin, apiKey);
    default:
      return fetchRainforest(asin, apiKey);
  }
}

export async function calcLtcAmount(priceJpy: number): Promise<number | null> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=jpy',
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const ltcJpy: number = data.litecoin?.jpy;
    if (!ltcJpy) return null;
    return Math.round((priceJpy / 3 / ltcJpy) * 1e8) / 1e8;
  } catch {
    return null;
  }
}

export function buildPaymentEmbed(
  title: string,
  variantLabel: string | null,
  priceJpy: number,
  ltcAmount: number | null,
  ltcAddress: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('💳 お支払い情報')
    .setColor(0x345d9d)
    .addFields({ name: '商品', value: title.slice(0, 256), inline: false });

  if (variantLabel) embed.addFields({ name: 'バリエーション', value: variantLabel, inline: false });

  embed.addFields(
    { name: 'Amazon価格', value: `¥${priceJpy.toLocaleString()}`, inline: true },
    {
      name: 'お支払い金額 (1/3)',
      value: ltcAmount ? `${ltcAmount} LTC` : '取得失敗 — 後で再試行して',
      inline: true,
    },
  );

  embed.addFields({ name: 'LTC送付先アドレス', value: `\`${ltcAddress}\``, inline: false });

  if (ltcAmount) {
    embed.addFields({
      name: 'ウォレットURI',
      value: `\`litecoin:${ltcAddress}?amount=${ltcAmount}\``,
      inline: false,
    });
  }

  embed.setFooter({
    text: '送金後、スタッフに取引IDを連絡してください。確認後に商品リンクをお送りします。',
  });

  return embed;
}
