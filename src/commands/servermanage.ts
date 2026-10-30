import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
  EmbedBuilder,
} from 'discord.js';
import type { Command } from '../types.js';
import { isStaff } from '../permissions.js';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('サーバー管理コマンド')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('lock')
        .setDescription('チャンネルを@everyoneの発言禁止にする')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('対象チャンネル(省略時は実行チャンネル)').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('unlock')
        .setDescription('チャンネルの発言禁止を解除する')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('対象チャンネル(省略時は実行チャンネル)').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('announce')
        .setDescription('指定チャンネルにアナウンスを送る')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('送信先').setRequired(true).addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((o) => o.setName('title').setDescription('タイトル').setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('本文').setRequired(true)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('slowmode')
        .setDescription('スローモードを設定する')
        .addIntegerOption((o) =>
          o.setName('seconds').setDescription('秒数(0で解除)').setRequired(true).setMinValue(0).setMaxValue(21600),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('対象チャンネル(省略時は実行チャンネル)').addChannelTypes(ChannelType.GuildText),
        ),
    ),

  async execute(interaction) {
    const member = interaction.member;
    if (!member || !('roles' in member) || !isStaff(member as any)) {
      await interaction.reply({ content: '権限がない。', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const targetChannel =
      (interaction.options.getChannel('channel') as TextChannel | null) ??
      (interaction.channel as TextChannel);

    if (sub === 'lock' || sub === 'unlock') {
      const lock = sub === 'lock';
      await targetChannel.permissionOverwrites.edit(interaction.guild!.roles.everyone, {
        SendMessages: lock ? false : null,
      });
      await interaction.reply({
        content: `<#${targetChannel.id}> を${lock ? 'ロック' : 'アンロック'}した。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'announce') {
      const channel = interaction.options.getChannel('channel', true) as TextChannel;
      const title = interaction.options.getString('title', true);
      const message = interaction.options.getString('message', true);
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(message)
        .setColor(0x5865f2)
        .setTimestamp()
        .setFooter({ text: `by ${interaction.user.tag}` });
      await channel.send({ embeds: [embed] });
      await interaction.reply({ content: `<#${channel.id}> に送信した。`, ephemeral: true });
      return;
    }

    if (sub === 'slowmode') {
      const seconds = interaction.options.getInteger('seconds', true);
      await targetChannel.setRateLimitPerUser(seconds);
      await interaction.reply({
        content: `<#${targetChannel.id}> のスローモードを ${seconds}秒 に設定した。`,
        ephemeral: true,
      });
      return;
    }
  },
};

export default command;
