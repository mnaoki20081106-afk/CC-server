import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../types.js';
import { db } from '../db.js';
import { isStaff } from '../permissions.js';

const DAILY_AMOUNT = 100;
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getBalance(guildId: string, userId: string): number {
  const row = db.prepare('SELECT balance FROM economy WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as any;
  return row?.balance ?? 0;
}

function ensureAccount(guildId: string, userId: string) {
  db.prepare('INSERT OR IGNORE INTO economy (guild_id, user_id, balance) VALUES (?, ?, 0)').run(guildId, userId);
}

export function addBalance(guildId: string, userId: string, amount: number) {
  ensureAccount(guildId, userId);
  db.prepare('UPDATE economy SET balance = balance + ? WHERE guild_id = ? AND user_id = ?').run(amount, guildId, userId);
}

export function deductBalance(guildId: string, userId: string, amount: number): boolean {
  ensureAccount(guildId, userId);
  const bal = getBalance(guildId, userId);
  if (bal < amount) return false;
  db.prepare('UPDATE economy SET balance = balance - ? WHERE guild_id = ? AND user_id = ?').run(amount, guildId, userId);
  return true;
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('economy')
    .setDescription('サーバー内ポイント(自販機で使用)')
    .addSubcommand((sc) => sc.setName('balance').setDescription('自分の所持ポイントを確認'))
    .addSubcommand((sc) => sc.setName('daily').setDescription('デイリーポイントを受け取る'))
    .addSubcommand((sc) =>
      sc
        .setName('grant')
        .setDescription('ポイントを付与する(管理者のみ実行可)')
        .addUserOption((o) => o.setName('user').setDescription('対象ユーザー').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('付与量(負数で剮夺)').setRequired(true)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'balance') {
      const bal = getBalance(guildId, interaction.user.id);
      await interaction.reply({ content: `所持ポイント: **${bal}**`, ephemeral: true });
      return;
    }

    if (sub === 'daily') {
      ensureAccount(guildId, interaction.user.id);
      const row = db.prepare('SELECT last_daily FROM economy WHERE guild_id = ? AND user_id = ?').get(guildId, interaction.user.id) as any;
      const now = Date.now();
      if (row.last_daily && now - row.last_daily < DAILY_COOLDOWN_MS) {
        const remaining = DAILY_COOLDOWN_MS - (now - row.last_daily);
        const hours = Math.ceil(remaining / (60 * 60 * 1000));
        await interaction.reply({ content: `まだ受け取れない。あと約${hours}時間。`, ephemeral: true });
        return;
      }
      db.prepare('UPDATE economy SET balance = balance + ?, last_daily = ? WHERE guild_id = ? AND user_id = ?').run(
        DAILY_AMOUNT,
        now,
        guildId,
        interaction.user.id,
      );
      await interaction.reply({ content: `${DAILY_AMOUNT}ポイントを受け取った。`, ephemeral: true });
      return;
    }

    if (sub === 'grant') {
      const member = interaction.member;
      if (!member || !('roles' in member) || !isStaff(member as any)) {
        await interaction.reply({ content: '権限がない。', ephemeral: true });
        return;
      }
      const user = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      addBalance(guildId, user.id, amount);
      await interaction.reply({ content: `<@${user.id}> に ${amount}ポイントを付与した。`, ephemeral: true });
      return;
    }
  },
};

export default command;
