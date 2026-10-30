import {
  Events,
  Interaction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ChannelType,
  TextChannel,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import { commands } from '../commands/index.js';
import { db, getGuildConfig } from '../db.js';
import { closeTicket } from '../commands/ticket.js';
import { restoreBackup, backupFilePath } from '../commands/backup.js';
import { readFileSync } from 'node:fs';

const VERIFY_TTL_MS = 5 * 60 * 1000;

export const name = Events.InteractionCreate;

export async function execute(interaction: Interaction) {
  if (interaction.isChatInputCommand()) {
    const command = commands.find((c) => c.data.name === interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (err) {
      console.error(err);
      const payload = { content: 'コマンドの実行中にエラーが発生した。', ephemeral: true } as const;
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    }
    return;
  }

  if (interaction.isButton()) {
    const [namespace, action, extra] = interaction.customId.split(':');

    if (namespace === 'verify' && action === 'start') {
      const a = Math.floor(Math.random() * 8) + 1;
      const b = Math.floor(Math.random() * 8) + 1;
      db.prepare(
        'INSERT OR REPLACE INTO pending_verifications (guild_id, user_id, answer, expires_at) VALUES (?, ?, ?, ?)',
      ).run(interaction.guildId, interaction.user.id, a + b, Date.now() + VERIFY_TTL_MS);

      const modal = new ModalBuilder().setCustomId('verify:modal').setTitle('認証');
      const input = new TextInputBuilder()
        .setCustomId('verify_answer')
        .setLabel(`計算してください: ${a} + ${b} = ?`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(5);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (namespace === 'ticket' && action === 'open') {
      const cfg = getGuildConfig(interaction.guildId!);
      if (!cfg.ticket_category_id) {
        await interaction.reply({ content: 'チケットシステムが未設定。', ephemeral: true });
        return;
      }
      const existing = db
        .prepare('SELECT * FROM tickets WHERE guild_id = ? AND opener_id = ? AND status = ?')
        .get(interaction.guildId, interaction.user.id, 'open');
      if (existing) {
        await interaction.reply({ content: `既にチケットがある: <#${(existing as any).channel_id}>`, ephemeral: true });
        return;
      }

      const guild = interaction.guild!;
      const channel = await guild.channels.create({
        name: `ticket-${interaction.user.username}`.toLowerCase().slice(0, 90),
        type: ChannelType.GuildText,
        parent: cfg.ticket_category_id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ...(cfg.mod_role_id
            ? [{ id: cfg.mod_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }]
            : []),
          ...(cfg.admin_role_id
            ? [{ id: cfg.admin_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }]
            : []),
        ],
      });

      db.prepare('INSERT INTO tickets (guild_id, channel_id, opener_id, created_at) VALUES (?, ?, ?, ?)').run(
        interaction.guildId,
        channel.id,
        interaction.user.id,
        Date.now(),
      );

      const embed = new EmbedBuilder()
        .setTitle('🎫 チケット')
        .setDescription(`<@${interaction.user.id}> 内容を書いて待ってて。スタッフが対応する。`)
        .setColor(0x3498db);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('ticket:close').setLabel('クローズ').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
      );
      await channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: `チケットを作成した: <#${channel.id}>`, ephemeral: true });
      return;
    }

    if (namespace === 'ticket' && action === 'close') {
      const ticket = db
        .prepare('SELECT * FROM tickets WHERE channel_id = ? AND status = ?')
        .get(interaction.channelId, 'open');
      if (!ticket) {
        await interaction.reply({ content: 'このチャンネルはチケットではない。', ephemeral: true });
        return;
      }
      await closeTicket(interaction as any, ticket);
      return;
    }

    if (namespace === 'panel') {
      const buttonId = Number(action);
      const btn = db.prepare('SELECT * FROM panel_buttons WHERE id = ?').get(buttonId) as any;
      if (!btn) {
        await interaction.reply({ content: 'このボタンは無効になっている。', ephemeral: true });
        return;
      }
      if (btn.action_type === 'toggle_role') {
        const member = interaction.member;
        if (!member || !('roles' in member)) return;
        const has = (member as any).roles.cache.has(btn.action_value);
        if (has) await (member as any).roles.remove(btn.action_value).catch(() => {});
        else await (member as any).roles.add(btn.action_value).catch(() => {});
        await interaction.reply({ content: has ? 'ロールを解除した。' : 'ロールを付与した。', ephemeral: true });
        return;
      }
      if (btn.action_type === 'show_text') {
        await interaction.reply({ content: btn.action_value, ephemeral: true });
        return;
      }
      return;
    }

    if (namespace === 'backup' && action === 'restore') {
      const member = interaction.member;
      if (!member || !('permissions' in member) || !(member as any).permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '権限がない。', ephemeral: true });
        return;
      }
      await interaction.update({ content: '復元を実行中...', components: [] });
      const path = backupFilePath(interaction.guildId!, extra);
      const data = JSON.parse(readFileSync(path, 'utf8'));
      await restoreBackup(interaction.guild!, data);
      await interaction.followUp({ content: `バックアップ「${extra}」の復元が完了した。`, ephemeral: true });
      return;
    }

    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'verify:modal') {
    const pending = db
      .prepare('SELECT * FROM pending_verifications WHERE guild_id = ? AND user_id = ?')
      .get(interaction.guildId, interaction.user.id) as any;

    if (!pending || pending.expires_at < Date.now()) {
      await interaction.reply({ content: '認証がタイムアウトした。もう一度ボタンを押して。', ephemeral: true });
      return;
    }

    const answer = Number(interaction.fields.getTextInputValue('verify_answer').trim());
    if (answer !== pending.answer) {
      await interaction.reply({ content: '答えが違う。もう一度ボタンを押して。', ephemeral: true });
      return;
    }

    db.prepare('DELETE FROM pending_verifications WHERE guild_id = ? AND user_id = ?').run(
      interaction.guildId,
      interaction.user.id,
    );
    db.prepare(
      'INSERT OR REPLACE INTO verified_users (guild_id, user_id, verified_at) VALUES (?, ?, ?)',
    ).run(interaction.guildId, interaction.user.id, Date.now());

    const cfg = getGuildConfig(interaction.guildId!);
    if (cfg.verified_role_id) {
      const member = interaction.member;
      if (member && 'roles' in member) await (member as any).roles.add(cfg.verified_role_id).catch(() => {});
    }
    await interaction.reply({ content: '✅ 認証完了。', ephemeral: true });
    return;
  }
}
