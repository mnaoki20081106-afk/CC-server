import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  CategoryChannel,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Command } from '../types.js';
import { updateGuildConfig, db } from '../db.js';
import { isStaff } from '../permissions.js';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('チケットシステム')
    .addSubcommand((sc) =>
      sc
        .setName('setup')
        .setDescription('チケットパネルを設置する(管理者)')
        .addChannelOption((o) =>
          o.setName('panel_channel').setDescription('パネル設置先').setRequired(true).addChannelTypes(ChannelType.GuildText),
        )
        .addChannelOption((o) =>
          o
            .setName('category')
            .setDescription('チケット作成先カテゴリ')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory),
        )
        .addChannelOption((o) =>
          o.setName('log_channel').setDescription('クローズログ送信先').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) => sc.setName('close').setDescription('このチケットをクローズする'))
    .addSubcommand((sc) =>
      sc
        .setName('add')
        .setDescription('このチケットにユーザーを追加する')
        .addUserOption((o) => o.setName('user').setDescription('追加するユーザー').setRequired(true)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'setup') {
      const member = interaction.member;
      if (!member || !('roles' in member) || !isStaff(member as any)) {
        await interaction.reply({ content: '権限がない。', ephemeral: true });
        return;
      }
      const panelChannel = interaction.options.getChannel('panel_channel', true) as TextChannel;
      const category = interaction.options.getChannel('category', true) as CategoryChannel;
      const logChannel = interaction.options.getChannel('log_channel') as TextChannel | null;

      updateGuildConfig(guildId, {
        ticket_category_id: category.id,
        ticket_log_channel_id: logChannel?.id ?? null,
      });

      const embed = new EmbedBuilder()
        .setTitle('🎫 サロート')
        .setDescription('問い合わせがあればボタンを押してチケットを作成する。')
        .setColor(0x3498db);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('ticket:open').setLabel('チケットを作成').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
      );
      await panelChannel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: `<#${panelChannel.id}> にチケットパネルを設置した。`, ephemeral: true });
      return;
    }

    if (sub === 'close') {
      const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND status = ?').get(interaction.channelId, 'open') as any;
      if (!ticket) {
        await interaction.reply({ content: 'このチャンネルはチケットではない。', ephemeral: true });
        return;
      }
      await closeTicket(interaction, ticket);
      return;
    }

    if (sub === 'add') {
      const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND status = ?').get(interaction.channelId, 'open') as any;
      if (!ticket) {
        await interaction.reply({ content: 'このチャンネルはチケットではない。', ephemeral: true });
        return;
      }
      const user = interaction.options.getUser('user', true);
      const channel = interaction.channel as TextChannel;
      await channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true });
      await interaction.reply({ content: `<@${user.id}> を追加した。` });
      return;
    }
  },
};

export async function closeTicket(interaction: { channel: any; guild: any; user: any; reply: Function }, ticket: any) {
  const now = Date.now();
  db.prepare('UPDATE tickets SET status = ?, closed_at = ?, closed_by = ? WHERE id = ?').run(
    'closed',
    now,
    interaction.user.id,
    ticket.id,
  );

  const cfg = (interaction.guild ? db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(interaction.guild.id) : null) as any;
  if (cfg?.ticket_log_channel_id) {
    const logChannel = interaction.guild.channels.cache.get(cfg.ticket_log_channel_id) as TextChannel | undefined;
    if (logChannel) {
      await logChannel.send(
        `🔒 チケット #${ticket.id} (opener: <@${ticket.opener_id}>) を <@${interaction.user.id}> がクローズした。`,
      );
    }
  }

  await interaction.reply({ content: 'このチケットを10秒後にクローズする。' });
  setTimeout(() => {
    interaction.channel.delete().catch(() => {});
  }, 10_000);
}

export default command;
