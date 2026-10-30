import { GuildMember, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './db.js';

/** True if the member is a server admin, or holds the configured admin/mod role. */
export function isStaff(member: GuildMember): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const cfg = getGuildConfig(member.guild.id);
  if (cfg.admin_role_id && member.roles.cache.has(cfg.admin_role_id)) return true;
  if (cfg.mod_role_id && member.roles.cache.has(cfg.mod_role_id)) return true;
  return false;
}

export function isAdmin(member: GuildMember): boolean {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const cfg = getGuildConfig(member.guild.id);
  return Boolean(cfg.admin_role_id && member.roles.cache.has(cfg.admin_role_id));
}
