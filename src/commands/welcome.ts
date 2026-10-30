import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, TextChannel } from 'discord.js';
import type { Command } from '../types.js';
import { updateGuildConfig } from '../db.js';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('入退室管理の設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) =>
      sc
        .setName('join')
        .setDescription('入室メッセージを設定する')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('送信先').setRequired(true).addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((o) =>
          o
            .setName('message')
            .setDescription('{user}=メンション {tag}=ユーザー名 {membercount}=人数 が使える')
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('leave')
        .setDescription('退室メッセージを設定する')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('送信先').setRequired(true).addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((o) =>
          o.setName('message').setDescription('{tag}=ユーザー名 {membercount}=人数 が使える').setRequired(true),
        ),
    )
    .addSubcommand((sc) => sc.setName('disable_join').setDescription('入室メッセージを無効化する'))
    .addSubcommand((sc) => sc.setName('disable_leave').setDescription('退室メッセージを無効化する')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'join') {
      const channel = interaction.options.getChannel('channel', true) as TextChannel;
      const message = interaction.options.getString('message', true);
      updateGuildConfig(guildId, { welcome_channel_id: channel.id, welcome_message: message });
      await interaction.reply({ content: `入室メッセージを <#${channel.id}> に設定した。`, ephemeral: true });
      return;
    }

    if (sub === 'leave') {
      const channel = interaction.options.getChannel('channel', true) as TextChannel;
      const message = interaction.options.getString('message', true);
      updateGuildConfig(guildId, { leave_channel_id: channel.id, leave_message: message });
      await interaction.reply({ content: `退室メッセージを <#${channel.id}> に設定した。`, ephemeral: true });
      return;
    }

    if (sub === 'disable_join') {
      updateGuildConfig(guildId, { welcome_channel_id: null });
      await interaction.reply({ content: '入室メッセージを無効化した。', ephemeral: true });
      return;
    }

    if (sub === 'disable_leave') {
      updateGuildConfig(guildId, { leave_channel_id: null });
      await interaction.reply({ content: '退室メッセージを無効化した。', ephemeral: true });
      return;
    }
  },
};

export default command;
