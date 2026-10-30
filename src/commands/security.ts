import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { Command } from '../types.js';
import { updateGuildConfig, getGuildConfig, db } from '../db.js';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('security')
    .setDescription('セキュリティ設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) =>
      sc
        .setName('antispam')
        .setDescription('アンチスパムの設定')
        .addBooleanOption((o) => o.setName('enabled').setDescription('有効/無効').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('threshold').setDescription('時間内の最大メッセージ数').setMinValue(2).setMaxValue(30),
        )
        .addIntegerOption((o) => o.setName('window_seconds').setDescription('判定ウィンドウ(秒)').setMinValue(2).setMaxValue(60)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('antilink')
        .setDescription('URL自動削除の設定')
        .addBooleanOption((o) => o.setName('enabled').setDescription('有効/無効').setRequired(true)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('antilink_whitelist')
        .setDescription('アンチリンクの許可ドメインを追加/削除')
        .addStringOption((o) => o.setName('domain').setDescription('例: discord.com').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('add/remove')
            .setRequired(true)
            .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('raidprotection')
        .setDescription('レイド対策(短時間の大量参加)の設定')
        .addBooleanOption((o) => o.setName('enabled').setDescription('有効/無効').setRequired(true))
        .addIntegerOption((o) => o.setName('join_threshold').setDescription('ウィンドウ内の最大参加数').setMinValue(3).setMaxValue(100))
        .addIntegerOption((o) => o.setName('window_seconds').setDescription('判定ウィンドウ(秒)').setMinValue(5).setMaxValue(300))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('検知時の動作')
            .addChoices({ name: '新規参加者のロールを剮夺せず通知のみ', value: 'alert' }, { name: '招待リンクを一時的に削除してロック', value: 'lock' }),
        ),
    )
    .addSubcommand((sc) => sc.setName('log').setDescription('直近のセキュリティイベントを表示')),

  async execute(interaction) {
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand();

    if (sub === 'antispam') {
      const enabled = interaction.options.getBoolean('enabled', true);
      const threshold = interaction.options.getInteger('threshold');
      const windowSeconds = interaction.options.getInteger('window_seconds');
      const fields: Record<string, unknown> = { anti_spam_enabled: enabled ? 1 : 0 };
      if (threshold) fields.anti_spam_threshold = threshold;
      if (windowSeconds) fields.anti_spam_window_ms = windowSeconds * 1000;
      updateGuildConfig(guildId, fields);
      await interaction.reply({ content: `アンチスパムを${enabled ? '有効' : '無効'}にした。`, ephemeral: true });
      return;
    }

    if (sub === 'antilink') {
      const enabled = interaction.options.getBoolean('enabled', true);
      updateGuildConfig(guildId, { anti_link_enabled: enabled ? 1 : 0 });
      await interaction.reply({ content: `アンチリンクを${enabled ? '有効' : '無効'}にした。`, ephemeral: true });
      return;
    }

    if (sub === 'antilink_whitelist') {
      const domain = interaction.options.getString('domain', true).toLowerCase();
      const action = interaction.options.getString('action', true);
      const cfg = getGuildConfig(guildId);
      let list: string[] = JSON.parse(cfg.anti_link_whitelist || '[]');
      if (action === 'add' && !list.includes(domain)) list.push(domain);
      if (action === 'remove') list = list.filter((d) => d !== domain);
      updateGuildConfig(guildId, { anti_link_whitelist: JSON.stringify(list) });
      await interaction.reply({ content: `ホワイトリスト: ${list.join(', ') || '(なし)'}`, ephemeral: true });
      return;
    }

    if (sub === 'raidprotection') {
      const enabled = interaction.options.getBoolean('enabled', true);
      const joinThreshold = interaction.options.getInteger('join_threshold');
      const windowSeconds = interaction.options.getInteger('window_seconds');
      const action = interaction.options.getString('action');
      const fields: Record<string, unknown> = { raid_protection_enabled: enabled ? 1 : 0 };
      if (joinThreshold) fields.raid_join_threshold = joinThreshold;
      if (windowSeconds) fields.raid_window_ms = windowSeconds * 1000;
      if (action) fields.raid_action = action;
      updateGuildConfig(guildId, fields);
      await interaction.reply({ content: `レイド対策を${enabled ? '有効' : '無効'}にした。`, ephemeral: true });
      return;
    }

    if (sub === 'log') {
      const rows = db
        .prepare('SELECT * FROM security_events WHERE guild_id = ? ORDER BY created_at DESC LIMIT 10')
        .all(guildId) as any[];
      if (rows.length === 0) {
        await interaction.reply({ content: 'イベントはまだない。', ephemeral: true });
        return;
      }
      const text = rows
        .map((r) => `\`${new Date(r.created_at).toISOString()}\` **${r.kind}** ${r.user_id ? `<@${r.user_id}>` : ''} ${r.detail ?? ''}`)
        .join('\n');
      await interaction.reply({ content: text, ephemeral: true });
      return;
    }
  },
};

export default command;
