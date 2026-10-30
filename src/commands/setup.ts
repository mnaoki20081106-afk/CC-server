import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import type { Command } from '../types.js';
import { updateGuildConfig, getGuildConfig } from '../db.js';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('サーバーの基本設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) =>
      sc
        .setName('roles')
        .setDescription('管理者/モデレーターロールを設定')
        .addRoleOption((o) => o.setName('admin').setDescription('管理者ロール').setRequired(false))
        .addRoleOption((o) => o.setName('mod').setDescription('モデレーターロール').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('log_channel')
        .setDescription('ログチャンネルを設定')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('ログ出力先').setRequired(true).addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sc) => sc.setName('show').setDescription('現在の設定を表示')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'roles') {
      const admin = interaction.options.getRole('admin');
      const mod = interaction.options.getRole('mod');
      const fields: Record<string, unknown> = {};
      if (admin) fields.admin_role_id = admin.id;
      if (mod) fields.mod_role_id = mod.id;
      updateGuildConfig(guildId, fields);
      await interaction.reply({ content: 'ロール設定を更新した。', ephemeral: true });
      return;
    }

    if (sub === 'log_channel') {
      const channel = interaction.options.getChannel('channel', true);
      updateGuildConfig(guildId, { log_channel_id: channel.id });
      await interaction.reply({ content: `ログチャンネルを <#${channel.id}> に設定した。`, ephemeral: true });
      return;
    }

    if (sub === 'show') {
      const cfg = getGuildConfig(guildId);
      const lines = [
        `管理ロール: ${cfg.admin_role_id ? `<@&${cfg.admin_role_id}>` : '未設定'}`,
        `モデレーターロール: ${cfg.mod_role_id ? `<@&${cfg.mod_role_id}>` : '未設定'}`,
        `ログチャンネル: ${cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : '未設定'}`,
        `認証ロール: ${cfg.verified_role_id ? `<@&${cfg.verified_role_id}>` : '未設定'}`,
        `入室チャンネル: ${cfg.welcome_channel_id ? `<#${cfg.welcome_channel_id}>` : '未設定'}`,
        `退室チャンネル: ${cfg.leave_channel_id ? `<#${cfg.leave_channel_id}>` : '未設定'}`,
        `チケットカテゴリ: ${cfg.ticket_category_id ? `<#${cfg.ticket_category_id}>` : '未設定'}`,
        `アンチスパム: ${cfg.anti_spam_enabled ? '有効' : '無効'}`,
        `アンチリンク: ${cfg.anti_link_enabled ? '有効' : '無効'}`,
        `レイド対策: ${cfg.raid_protection_enabled ? '有効' : '無効'}`,
      ];
      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      return;
    }
  },
};

export default command;
