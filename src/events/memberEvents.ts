import { Events, GuildMember, PartialGuildMember, TextChannel, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, db } from '../db.js';

function render(template: string, member: GuildMember, memberCount: number) {
  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{tag}', member.user.tag)
    .replaceAll('{membercount}', String(memberCount));
}

function logSecurityEvent(guildId: string, kind: string, userId: string | null, detail: string) {
  db.prepare('INSERT INTO security_events (guild_id, user_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(
    guildId,
    userId,
    kind,
    detail,
    Date.now(),
  );
}

export const guildMemberAdd = {
  name: Events.GuildMemberAdd,
  async execute(member: GuildMember) {
    const cfg = getGuildConfig(member.guild.id);
    const now = Date.now();
    db.prepare('INSERT INTO join_log (guild_id, user_id, joined_at) VALUES (?, ?, ?)').run(member.guild.id, member.id, now);

    if (cfg.welcome_channel_id && cfg.welcome_message) {
      const channel = member.guild.channels.cache.get(cfg.welcome_channel_id) as TextChannel | undefined;
      if (channel) {
        await channel.send(render(cfg.welcome_message, member, member.guild.memberCount)).catch(() => {});
      }
    }

    if (cfg.raid_protection_enabled) {
      const windowStart = now - cfg.raid_window_ms;
      const recentJoins = db
        .prepare('SELECT COUNT(*) c FROM join_log WHERE guild_id = ? AND joined_at >= ?')
        .get(member.guild.id, windowStart) as any;

      if (recentJoins.c >= cfg.raid_join_threshold) {
        logSecurityEvent(
          member.guild.id,
          'raid_detected',
          member.id,
          `${recentJoins.c} joins within ${cfg.raid_window_ms}ms`,
        );

        if (cfg.log_channel_id) {
          const logChannel = member.guild.channels.cache.get(cfg.log_channel_id) as TextChannel | undefined;
          await logChannel
            ?.send(`🚨 レイド検知: ${recentJoins.c}人が短時間で参加した。直近参加者: <@${member.id}>`)
            .catch(() => {});
        }

        if (cfg.raid_action === 'lock') {
          const everyone = member.guild.roles.everyone;
          for (const channel of member.guild.channels.cache.values()) {
            if (channel.type === 0 && channel.permissionsFor(everyone)?.has(PermissionFlagsBits.SendMessages)) {
              await (channel as TextChannel).permissionOverwrites.edit(everyone, { SendMessages: false }).catch(() => {});
            }
          }
        }
      }
    }
  },
};

export const guildMemberRemove = {
  name: Events.GuildMemberRemove,
  async execute(member: GuildMember | PartialGuildMember) {
    const cfg = getGuildConfig(member.guild.id);
    if (cfg.leave_channel_id && cfg.leave_message) {
      const channel = member.guild.channels.cache.get(cfg.leave_channel_id) as TextChannel | undefined;
      if (channel) {
        const text = cfg.leave_message
          .replaceAll('{tag}', member.user.tag)
          .replaceAll('{membercount}', String(member.guild.memberCount));
        await channel.send(text).catch(() => {});
      }
    }
  },
};
