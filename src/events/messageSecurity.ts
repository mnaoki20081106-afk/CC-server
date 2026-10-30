import { Events, Message, TextChannel, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, db } from '../db.js';
import { isStaff } from '../permissions.js';

const URL_RE = /https?:\/\/([a-zA-Z0-9.-]+)[^\s]*/gi;

// userId -> timestamps of recent messages, kept in memory (per-process; fine for a single-shard bot).
const recentMessages = new Map<string, number[]>();

function logSecurityEvent(guildId: string, kind: string, userId: string | null, detail: string) {
  db.prepare('INSERT INTO security_events (guild_id, user_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(
    guildId,
    userId,
    kind,
    detail,
    Date.now(),
  );
}

export const name = Events.MessageCreate;

export async function execute(message: Message) {
  if (message.author.bot || !message.guild || !message.member) return;
  if (isStaff(message.member)) return;

  const cfg = getGuildConfig(message.guild.id);

  if (cfg.anti_link_enabled) {
    const matches = [...message.content.matchAll(URL_RE)];
    const whitelist: string[] = JSON.parse(cfg.anti_link_whitelist || '[]');
    const hasDisallowed = matches.some((m) => {
      const host = m[1].toLowerCase();
      return !whitelist.some((w) => host === w || host.endsWith(`.${w}`));
    });
    if (hasDisallowed) {
      await message.delete().catch(() => {});
      logSecurityEvent(message.guild.id, 'link_deleted', message.author.id, message.content.slice(0, 200));
      if (message.channel.isSendable()) {
        await message.channel
          .send(`<@${message.author.id}> このチャンネルでは許可されていないリンクは送れない。`)
          .then((m) => setTimeout(() => m.delete().catch(() => {}), 5000))
          .catch(() => {});
      }
      return;
    }
  }

  if (cfg.anti_spam_enabled) {
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    const windowStart = now - cfg.anti_spam_window_ms;
    const timestamps = (recentMessages.get(key) ?? []).filter((t) => t >= windowStart);
    timestamps.push(now);
    recentMessages.set(key, timestamps);

    if (timestamps.length > cfg.anti_spam_threshold) {
      recentMessages.set(key, []);
      logSecurityEvent(
        message.guild.id,
        'spam_detected',
        message.author.id,
        `${timestamps.length} messages within ${cfg.anti_spam_window_ms}ms`,
      );

      const member = message.member;
      if (member.moderatable) {
        await member.timeout(10 * 60 * 1000, 'Anti-spam: message rate exceeded').catch(() => {});
      }

      if (cfg.log_channel_id) {
        const logChannel = message.guild.channels.cache.get(cfg.log_channel_id) as TextChannel | undefined;
        await logChannel
          ?.send(`🤖 スパム検知: <@${message.author.id}> を10分間タイムアウトした。`)
          .catch(() => {});
      }
    }
  }
}
