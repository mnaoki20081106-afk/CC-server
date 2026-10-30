import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  OverwriteType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../types.js';
import { config } from '../config.js';

interface BackupData {
  guildId: string;
  guildName: string;
  createdAt: number;
  roles: Array<{
    name: string;
    color: number;
    hoist: boolean;
    mentionable: boolean;
    permissions: string;
    position: number;
  }>;
  channels: Array<{
    name: string;
    type: ChannelType;
    position: number;
    topic: string | null;
    parentName: string | null;
    permissionOverwrites: Array<{ roleName: string | null; allow: string; deny: string }>;
  }>;
}

function backupFilePath(guildId: string, name: string) {
  return join(config.backupDir, `${guildId}_${name}.json`);
}

async function createBackup(guild: import('discord.js').Guild, name: string): Promise<BackupData> {
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id)
    .map((r) => ({
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions.bitfield.toString(),
      position: r.position,
    }));

  const channels = guild.channels.cache.map((c: any) => ({
    name: c.name,
    type: c.type,
    position: c.position ?? 0,
    topic: 'topic' in c ? c.topic ?? null : null,
    parentName: c.parent?.name ?? null,
    permissionOverwrites: (c.permissionOverwrites?.cache.map((ow: any) => ({
      roleName: ow.type === OverwriteType.Role ? guild.roles.cache.get(ow.id)?.name ?? null : null,
      allow: ow.allow.bitfield.toString(),
      deny: ow.deny.bitfield.toString(),
    })) ?? []).filter((ow: any) => ow.roleName !== null),
  }));

  const data: BackupData = {
    guildId: guild.id,
    guildName: guild.name,
    createdAt: Date.now(),
    roles,
    channels,
  };

  writeFileSync(backupFilePath(guild.id, name), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

async function restoreBackup(guild: import('discord.js').Guild, data: BackupData) {
  const roleNameToId = new Map<string, string>();

  // Recreate missing roles first (matched by exact name).
  for (const r of data.roles) {
    const existing = guild.roles.cache.find((x) => x.name === r.name);
    if (existing) {
      roleNameToId.set(r.name, existing.id);
      continue;
    }
    const created = await guild.roles.create({
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: BigInt(r.permissions),
    });
    roleNameToId.set(r.name, created.id);
  }

  // Recreate missing categories first, then channels under them.
  const categories = data.channels.filter((c) => c.type === ChannelType.GuildCategory);
  const others = data.channels.filter((c) => c.type !== ChannelType.GuildCategory);
  const categoryNameToId = new Map<string, string>();

  for (const c of categories) {
    const existing = guild.channels.cache.find((x) => x.name === c.name && x.type === ChannelType.GuildCategory);
    if (existing) {
      categoryNameToId.set(c.name, existing.id);
      continue;
    }
    const created = await guild.channels.create({ name: c.name, type: ChannelType.GuildCategory });
    categoryNameToId.set(c.name, created.id);
  }

  for (const c of others) {
    const existing = guild.channels.cache.find((x) => x.name === c.name && x.type === c.type);
    if (existing) continue;
    const parentId = c.parentName ? categoryNameToId.get(c.parentName) : undefined;
    const overwrites = c.permissionOverwrites
      .map((ow) => {
        const roleId = ow.roleName ? roleNameToId.get(ow.roleName) : undefined;
        if (!roleId) return null;
        return { id: roleId, allow: BigInt(ow.allow), deny: BigInt(ow.deny) };
      })
      .filter((x): x is { id: string; allow: bigint; deny: bigint } => x !== null);

    await guild.channels.create({
      name: c.name,
      type: c.type as any,
      parent: parentId,
      topic: c.topic ?? undefined,
      permissionOverwrites: overwrites,
    });
  }
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('サーバー構成のバックアップ')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sc) =>
      sc
        .setName('create')
        .setDescription('現在のロール/チャンネル構成を保存する')
        .addStringOption((o) => o.setName('name').setDescription('バックアップ名').setRequired(true)),
    )
    .addSubcommand((sc) => sc.setName('list').setDescription('保存済みバックアップ一覧'))
    .addSubcommand((sc) =>
      sc
        .setName('restore')
        .setDescription('保存した構成から不足分を復元する(既存の要素は削除しない)')
        .addStringOption((o) => o.setName('name').setDescription('バックアップ名').setRequired(true)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild!;

    if (sub === 'create') {
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.options.getString('name', true).replace(/[^a-zA-Z0-9_-]/g, '_');
      const data = await createBackup(guild, name);
      await interaction.editReply(
        `バックアップ「${name}」を保存した。ロール${data.roles.length}件、チャンネル${data.channels.length}件。`,
      );
      return;
    }

    if (sub === 'list') {
      const files = readdirSync(config.backupDir).filter((f) => f.startsWith(`${guild.id}_`) && f.endsWith('.json'));
      if (files.length === 0) {
        await interaction.reply({ content: 'バックアップはまだない。', ephemeral: true });
        return;
      }
      const names = files.map((f) => f.slice(guild.id.length + 1, -'.json'.length));
      await interaction.reply({ content: names.map((n) => `- ${n}`).join('\n'), ephemeral: true });
      return;
    }

    if (sub === 'restore') {
      const name = interaction.options.getString('name', true).replace(/[^a-zA-Z0-9_-]/g, '_');
      const path = backupFilePath(guild.id, name);
      let data: BackupData;
      try {
        data = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        await interaction.reply({ content: `バックアップ「${name}」が見つからない。`, ephemeral: true });
        return;
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`backup:restore:${name}`).setLabel('復元を実行').setStyle(ButtonStyle.Danger),
      );
      await interaction.reply({
        content: `バックアップ「${name}」(ロール${data.roles.length}件、チャンネル${data.channels.length}件)から、現在**存在しないロール/チャンネルのみ**を作成する。既存のものは削除・変更しない。実行する?`,
        components: [row],
        ephemeral: true,
      });
      return;
    }
  },
};

export { restoreBackup, backupFilePath };
export default command;
