import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Command } from '../types.js';
import { db } from '../db.js';

const STYLE_MAP: Record<string, ButtonStyle> = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger,
};

async function renderPanel(channelOrInteraction: any, panelId: number) {
  const panel = db.prepare('SELECT * FROM panels WHERE id = ?').get(panelId) as any;
  const buttons = db.prepare('SELECT * FROM panel_buttons WHERE panel_id = ?').all(panelId) as any[];

  const embed = new EmbedBuilder().setTitle(panel.title).setColor(0x9b59b6);
  if (panel.description) embed.setDescription(panel.description);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    const chunk = buttons.slice(i, i + 5);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      chunk.map((b) =>
        new ButtonBuilder()
          .setCustomId(`panel:${b.id}`)
          .setLabel(b.label)
          .setStyle(STYLE_MAP[b.style] ?? ButtonStyle.Primary)
          .setEmoji(b.emoji || undefined),
      ),
    );
    rows.push(row);
  }
  return { embed, rows, panel };
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('汎用パネル管理(埋め込み+ボタン)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('create')
        .setDescription('新しいパネルを作成する')
        .addStringOption((o) => o.setName('title').setDescription('タイトル').setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('説明文')),
    )
    .addSubcommand((sc) =>
      sc
        .setName('add_button')
        .setDescription('パネルにボタンを追加する')
        .addIntegerOption((o) => o.setName('panel_id').setDescription('panel create で表示されたID').setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('ボタンのラベル').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('ボタンを押した時の動作')
            .setRequired(true)
            .addChoices(
              { name: 'ロールを付与/解除(トグル)', value: 'toggle_role' },
              { name: 'リンクを表示', value: 'show_text' },
            ),
        )
        .addStringOption((o) => o.setName('value').setDescription('toggle_role=ロールID / show_text=表示する文章').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('style')
            .setDescription('ボタンの色')
            .addChoices(
              { name: 'Primary(青)', value: 'Primary' },
              { name: 'Secondary(灰)', value: 'Secondary' },
              { name: 'Success(緑)', value: 'Success' },
              { name: 'Danger(赤)', value: 'Danger' },
            ),
        )
        .addStringOption((o) => o.setName('emoji').setDescription('絵文字')),
    )
    .addSubcommand((sc) =>
      sc
        .setName('post')
        .setDescription('パネルをチャンネルに投稿する')
        .addIntegerOption((o) => o.setName('panel_id').setDescription('パネルID').setRequired(true))
        .addChannelOption((o) =>
          o.setName('channel').setDescription('投稿先').setRequired(true).addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) => sc.setName('list').setDescription('このサーバーのパネル一覧')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'create') {
      const title = interaction.options.getString('title', true);
      const description = interaction.options.getString('description');
      const result = db
        .prepare('INSERT INTO panels (guild_id, title, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, title, description ?? null, interaction.user.id, Date.now());
      await interaction.reply({
        content: `パネルを作成した。ID: **${result.lastInsertRowid}**\n続けて \`/panel add_button\` でボタンを追加できる。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'add_button') {
      const panelId = interaction.options.getInteger('panel_id', true);
      const panel = db.prepare('SELECT * FROM panels WHERE id = ? AND guild_id = ?').get(panelId, guildId);
      if (!panel) {
        await interaction.reply({ content: 'そのIDのパネルが見つからない。', ephemeral: true });
        return;
      }
      const label = interaction.options.getString('label', true);
      const action = interaction.options.getString('action', true);
      const value = interaction.options.getString('value', true);
      const style = interaction.options.getString('style') ?? 'Primary';
      const emoji = interaction.options.getString('emoji');

      db.prepare(
        'INSERT INTO panel_buttons (panel_id, label, style, emoji, action_type, action_value) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(panelId, label, style, emoji ?? null, action, value);

      await interaction.reply({ content: `パネル #${panelId} にボタン「${label}」を追加した。`, ephemeral: true });
      return;
    }

    if (sub === 'post') {
      const panelId = interaction.options.getInteger('panel_id', true);
      const panel = db.prepare('SELECT * FROM panels WHERE id = ? AND guild_id = ?').get(panelId, guildId) as any;
      if (!panel) {
        await interaction.reply({ content: 'そのIDのパネルが見つからない。', ephemeral: true });
        return;
      }
      const channel = interaction.options.getChannel('channel', true) as TextChannel;
      const { embed, rows } = await renderPanel(channel, panelId);
      const msg = await channel.send({ embeds: [embed], components: rows });
      db.prepare('UPDATE panels SET message_id = ?, channel_id = ? WHERE id = ?').run(msg.id, channel.id, panelId);
      await interaction.reply({ content: `<#${channel.id}> に投稿した。`, ephemeral: true });
      return;
    }

    if (sub === 'list') {
      const panels = db.prepare('SELECT * FROM panels WHERE guild_id = ? ORDER BY id').all(guildId) as any[];
      if (panels.length === 0) {
        await interaction.reply({ content: 'パネルはまだない。', ephemeral: true });
        return;
      }
      const text = panels
        .map((p) => `**#${p.id}** ${p.title} ${p.channel_id ? `(投稿先: <#${p.channel_id}>)` : '(未投稿)'}`)
        .join('\n');
      await interaction.reply({ content: text, ephemeral: true });
      return;
    }
  },
};

export { renderPanel };
export default command;
