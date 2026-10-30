import {
  SlashCommandBuilder,
  ChannelType,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Command } from '../types.js';
import { db } from '../db.js';
import { isStaff } from '../permissions.js';

function getOrCreateConfig(guildId: string): any {
  const existing = db
    .prepare('SELECT * FROM amazon_vending_config WHERE guild_id = ?')
    .get(guildId) as any;
  if (existing) return existing;
  db.prepare('INSERT INTO amazon_vending_config (guild_id) VALUES (?)').run(guildId);
  return db
    .prepare('SELECT * FROM amazon_vending_config WHERE guild_id = ?')
    .get(guildId) as any;
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('amazon-vending')
    .setDescription('Amazon自販機 — 管理')
    .addSubcommand((sc) =>
      sc
        .setName('config')
        .setDescription('Amazon自販機の設定 (スタッフのみ)')
        .addStringOption((o) =>
          o
            .setName('api_type')
            .setDescription('使用するAmazon API')
            .addChoices(
              { name: 'Rainforest API', value: 'rainforest' },
              { name: 'Keepa API', value: 'keepa' },
              { name: 'Canopy API', value: 'canopy' },
            ),
        )
        .addStringOption((o) => o.setName('api_key').setDescription('APIキー'))
        .addStringOption((o) =>
          o.setName('ltc_address').setDescription('LTC受け取りウォレットアドレス'),
        )
        .addStringOption((o) => o.setName('panel_title').setDescription('パネルのタイトル'))
        .addStringOption((o) =>
          o.setName('panel_description').setDescription('パネルの説明文'),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('post')
        .setDescription('Amazon自販機パネルをチャンネルに投稿する (スタッフのみ)')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('投稿先チャンネル')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) =>
      sc.setName('view').setDescription('現在の設定を確認する (スタッフのみ)'),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    const member = interaction.member;
    if (!member || !('roles' in member) || !isStaff(member as any)) {
      await interaction.reply({ content: '権限がない。', ephemeral: true });
      return;
    }

    if (sub === 'config') {
      const cfg = getOrCreateConfig(guildId);

      const updates: Record<string, any> = {};
      const apiType = interaction.options.getString('api_type');
      const apiKey = interaction.options.getString('api_key');
      const ltcAddress = interaction.options.getString('ltc_address');
      const panelTitle = interaction.options.getString('panel_title');
      const panelDescription = interaction.options.getString('panel_description');

      if (apiType) updates.api_type = apiType;
      if (apiKey) updates.api_key = apiKey;
      if (ltcAddress) updates.ltc_address = ltcAddress;
      if (panelTitle) updates.panel_title = panelTitle;
      if (panelDescription) updates.panel_description = panelDescription;

      if (Object.keys(updates).length === 0) {
        await interaction.reply({
          content: '更新するフィールドを少なくとも1つ指定して。',
          ephemeral: true,
        });
        return;
      }

      const setClause = Object.keys(updates)
        .map((k) => `${k} = ?`)
        .join(', ');
      db.prepare(`UPDATE amazon_vending_config SET ${setClause} WHERE guild_id = ?`).run(
        ...Object.values(updates),
        guildId,
      );

      await interaction.reply({
        content: `設定を更新した: **${Object.keys(updates).join(', ')}**`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'view') {
      const cfg = db
        .prepare('SELECT * FROM amazon_vending_config WHERE guild_id = ?')
        .get(guildId) as any;
      if (!cfg) {
        await interaction.reply({
          content: '設定がない。`/amazon-vending config` で設定して。',
          ephemeral: true,
        });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle('Amazon自販機 — 設定')
        .setColor(0xff9900)
        .addFields(
          { name: 'APIタイプ', value: cfg.api_type ?? '未設定', inline: true },
          {
            name: 'APIキー',
            value: cfg.api_key ? `\`****${cfg.api_key.slice(-4)}\`` : '未設定',
            inline: true,
          },
          { name: 'LTCアドレス', value: cfg.ltc_address ?? '未設定', inline: false },
          {
            name: 'パネルタイトル',
            value: cfg.panel_title ?? '(デフォルト)',
            inline: true,
          },
          {
            name: 'パネル説明文',
            value: cfg.panel_description ?? '(デフォルト)',
            inline: true,
          },
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (sub === 'post') {
      const cfg = db
        .prepare('SELECT * FROM amazon_vending_config WHERE guild_id = ?')
        .get(guildId) as any;
      if (!cfg?.ltc_address || !cfg?.api_key) {
        await interaction.reply({
          content:
            '先に `/amazon-vending config` でAPIキーとLTCアドレスを設定して。',
          ephemeral: true,
        });
        return;
      }

      const channel = interaction.options.getChannel('channel', true) as TextChannel;
      const embed = new EmbedBuilder()
        .setTitle(cfg.panel_title ?? '🛍️ Amazon自販機')
        .setDescription(cfg.panel_description ?? 'Amazon商品をLTCで購入できます。')
        .setColor(0xff9900)
        .setFooter({ text: '支払いはLTC(ライトコイン)のみ対応' });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('av:buy')
          .setLabel('🛒 購入する')
          .setStyle(ButtonStyle.Primary),
      );

      await channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({
        content: `<#${channel.id}> にAmazon自販機パネルを投稿した。`,
        ephemeral: true,
      });
      return;
    }
  },
};

export default command;
