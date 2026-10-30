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
import { updateGuildConfig } from '../db.js';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('入室認証の設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) =>
      sc
        .setName('setup')
        .setDescription('認証パネルを設置する')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('パネル設置先').setRequired(true).addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((o) => o.setName('role').setDescription('認証後に付与するロール').setRequired(true)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub !== 'setup') return;

    const channel = interaction.options.getChannel('channel', true) as TextChannel;
    const role = interaction.options.getRole('role', true);

    updateGuildConfig(interaction.guildId!, {
      verified_role_id: role.id,
      verify_channel_id: channel.id,
    });

    const embed = new EmbedBuilder()
      .setTitle('🔐 認証')
      .setDescription('下のボタンを押して簡単な確認に答えると、サーバーの全チャンネルが見られるようになる。')
      .setColor(0x2ecc71);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('verify:start').setLabel('認証する').setStyle(ButtonStyle.Success).setEmoji('✅'),
    );

    await channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: `<#${channel.id}> に認証パネルを設置した。`, ephemeral: true });
  },
};

export default command;
