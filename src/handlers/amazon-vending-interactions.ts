import {
  Interaction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import {
  extractAsin,
  fetchProduct,
  calcLtcAmount,
  buildPaymentEmbed,
} from '../lib/amazon-vending-helpers.js';

export async function handleAmazonVendingButton(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton()) return false;
  const [ns, action] = interaction.customId.split(':');
  if (ns !== 'av' || action !== 'buy') return false;

  const modal = new ModalBuilder()
    .setCustomId('av:url_modal')
    .setTitle('Amazon URLを入力');
  const input = new TextInputBuilder()
    .setCustomId('av_url')
    .setLabel('Amazon URL または ASIN')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://www.amazon.co.jp/dp/B0XXXXXX または B0XXXXXX')
    .setRequired(true)
    .setMaxLength(500);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
  return true;
}

export async function handleAmazonVendingModal(interaction: Interaction): Promise<boolean> {
  if (!interaction.isModalSubmit() || interaction.customId !== 'av:url_modal') return false;

  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId!;
  const cfg = db
    .prepare('SELECT * FROM amazon_vending_config WHERE guild_id = ?')
    .get(guildId) as any;

  if (!cfg?.api_key || !cfg?.ltc_address) {
    await interaction.editReply({
      content: 'Amazon自販機が設定されていない。管理者に問い合わせて。',
    });
    return true;
  }

  const raw = interaction.fields.getTextInputValue('av_url').trim();
  const asin = extractAsin(raw);
  if (!asin) {
    await interaction.editReply({
      content: '有効なAmazon URLまたはASINを入力して。\n例: `https://www.amazon.co.jp/dp/B0XXXXXX` または `B0XXXXXX`',
    });
    return true;
  }

  const product = await fetchProduct(asin, cfg.api_type ?? 'rainforest', cfg.api_key).catch(
    () => null,
  );

  if (!product) {
    await interaction.editReply({
      content: '商品情報の取得に失敗した。URLを確認して再試行して。',
    });
    return true;
  }

  // Clean sessions older than 30 minutes
  db.prepare('DELETE FROM amazon_vending_sessions WHERE created_at < ?').run(
    Date.now() - 30 * 60 * 1000,
  );

  const sessionId = randomUUID();
  db.prepare(
    'INSERT INTO amazon_vending_sessions (id, guild_id, user_id, asin, product_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sessionId, guildId, interaction.user.id, asin, JSON.stringify(product), Date.now());

  // No variants or only 1 — skip selection, go straight to payment
  const filteredVariants = product.variants.filter((v) => v.asin !== asin);
  if (filteredVariants.length === 0) {
    const priceJpy = product.price_jpy;
    if (!priceJpy) {
      await interaction.editReply({
        content: '商品の価格を取得できなかった。スタッフに直接問い合わせて。',
      });
      return true;
    }
    const ltcAmount = await calcLtcAmount(priceJpy);
    const embed = buildPaymentEmbed(product.title, null, priceJpy, ltcAmount, cfg.ltc_address);
    await interaction.editReply({ embeds: [embed] });
    return true;
  }

  // Show variant select menu
  const options = filteredVariants.slice(0, 25).map((v) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(v.label.slice(0, 100))
      .setValue(`${v.asin}:${v.price_jpy ?? 0}`)
      .setDescription(
        v.price_jpy ? `¥${v.price_jpy.toLocaleString()}` : '価格情報なし',
      ),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`av:sel:${sessionId}`)
    .setPlaceholder('バリエーションを選択してください')
    .addOptions(options);

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const embed = new EmbedBuilder()
    .setTitle(product.title.slice(0, 256))
    .setColor(0xff9900)
    .setDescription(
      `**${filteredVariants.length}件**のバリエーションが見つかりました。購入するものを選択してください。`,
    )
    .addFields({
      name: 'ご注意',
      value: 'Amazon価格の **1/3** をLTCでお支払いいただきます。',
    });

  await interaction.editReply({ embeds: [embed], components: [row] });
  return true;
}

export async function handleAmazonVendingSelect(interaction: Interaction): Promise<boolean> {
  if (!interaction.isStringSelectMenu()) return false;
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'av' || parts[1] !== 'sel') return false;

  const sessionId = parts[2];
  await interaction.deferUpdate();

  const session = db
    .prepare(
      'SELECT * FROM amazon_vending_sessions WHERE id = ? AND guild_id = ? AND user_id = ?',
    )
    .get(sessionId, interaction.guildId!, interaction.user.id) as any;

  if (!session) {
    await interaction.editReply({
      content: 'セッションが期限切れ。もう一度「購入する」ボタンを押して。',
      components: [],
    });
    return true;
  }

  const cfg = db
    .prepare('SELECT * FROM amazon_vending_config WHERE guild_id = ?')
    .get(interaction.guildId!) as any;

  const selected = interaction.values[0]; // "ASIN:price_jpy"
  const colonIdx = selected.lastIndexOf(':');
  const variantAsin = selected.slice(0, colonIdx);
  const priceJpy = Number(selected.slice(colonIdx + 1));

  const product = JSON.parse(session.product_json) as any;
  const variant = product.variants?.find((v: any) => v.asin === variantAsin);
  const variantLabel = variant?.label ?? variantAsin;

  const finalPrice = priceJpy || product.price_jpy;
  if (!finalPrice) {
    await interaction.editReply({
      content: 'このバリエーションの価格情報がない。スタッフに問い合わせて。',
      components: [],
    });
    return true;
  }

  const ltcAmount = await calcLtcAmount(finalPrice);
  const embed = buildPaymentEmbed(
    product.title,
    variantLabel,
    finalPrice,
    ltcAmount,
    cfg.ltc_address,
  );

  await interaction.editReply({ embeds: [embed], components: [] });
  return true;
}
