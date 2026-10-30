import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import type { Command } from '../types.js';
import { db } from '../db.js';
import { deductBalance, addBalance } from './economy.js';
import { isStaff } from '../permissions.js';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('自販機(サーバー内ショップ)')
    .addSubcommand((sc) => sc.setName('list').setDescription('販売中の商品一覧'))
    .addSubcommand((sc) =>
      sc
        .setName('buy')
        .setDescription('商品を購入する')
        .addIntegerOption((o) => o.setName('item_id').setDescription('商品ID').setRequired(true)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('additem')
        .setDescription('商品を追加する(管理者のみ実行可)')
        .addStringOption((o) => o.setName('name').setDescription('商品名').setRequired(true))
        .addIntegerOption((o) => o.setName('price').setDescription('価格(ポイント)').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('description').setDescription('説明'))
        .addRoleOption((o) => o.setName('role').setDescription('購入時に付与するロール(任意)')),
    )
    .addSubcommand((sc) =>
      sc
        .setName('addstock')
        .setDescription('在庫(配布するコード/キー)を追加する(管理者のみ実行可)')
        .addIntegerOption((o) => o.setName('item_id').setDescription('商品ID').setRequired(true))
        .addStringOption((o) => o.setName('payload').setDescription('購入者に送るテキスト(ライセンスキー等)').setRequired(true)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('removeitem')
        .setDescription('商品を非公開にする(管理者のみ実行可)')
        .addIntegerOption((o) => o.setName('item_id').setDescription('商品ID').setRequired(true)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'list') {
      const items = db.prepare('SELECT * FROM shop_items WHERE guild_id = ? AND active = 1').all(guildId) as any[];
      if (items.length === 0) {
        await interaction.reply({ content: '販売中の商品はない。', ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder().setTitle('🛒 自販機').setColor(0xf1c40f);
      for (const item of items) {
        const stock = db.prepare('SELECT COUNT(*) c FROM shop_stock WHERE item_id = ? AND claimed_by IS NULL').get(item.id) as any;
        embed.addFields({
          name: `#${item.id} ${item.name} — ${item.price}pt`,
          value: `${item.description ?? ''}\n在庫: ${stock.c}${item.role_id ? ` / 付与ロール: <@&${item.role_id}>` : ''}`,
        });
      }
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (sub === 'buy') {
      const itemId = interaction.options.getInteger('item_id', true);
      const item = db.prepare('SELECT * FROM shop_items WHERE id = ? AND guild_id = ? AND active = 1').get(itemId, guildId) as any;
      if (!item) {
        await interaction.reply({ content: '商品が見つからない。', ephemeral: true });
        return;
      }
      const stock = db
        .prepare('SELECT * FROM shop_stock WHERE item_id = ? AND claimed_by IS NULL ORDER BY id LIMIT 1')
        .get(itemId) as any;
      if (!stock) {
        await interaction.reply({ content: '在庫切れ。', ephemeral: true });
        return;
      }
      const ok = deductBalance(guildId, interaction.user.id, item.price);
      if (!ok) {
        await interaction.reply({ content: 'ポイントが足りない。`/economy balance` で確認を。', ephemeral: true });
        return;
      }

      db.prepare('UPDATE shop_stock SET claimed_by = ?, claimed_at = ? WHERE id = ?').run(
        interaction.user.id,
        Date.now(),
        stock.id,
      );
      db.prepare(
        'INSERT INTO shop_purchases (guild_id, user_id, item_id, stock_id, price_paid, purchased_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(guildId, interaction.user.id, itemId, stock.id, item.price, Date.now());

      if (item.role_id && interaction.member && 'roles' in interaction.member) {
        await (interaction.member as any).roles.add(item.role_id).catch(() => {});
      }

      try {
        await interaction.user.send(`✅ **${item.name}** を購入した。\n\`\`\`\n${stock.payload}\n\`\`\``);
        await interaction.reply({ content: `**${item.name}** を購入した。DMで内容を確認して。`, ephemeral: true });
      } catch {
        await interaction.reply({
          content: `**${item.name}** を購入した。DMが送れなかったので直接渡す:\n\`\`\`\n${stock.payload}\n\`\`\``,
          ephemeral: true,
        });
      }
      return;
    }

    const member = interaction.member;
    if (!member || !('roles' in member) || !isStaff(member as any)) {
      await interaction.reply({ content: '権限がない。', ephemeral: true });
      return;
    }

    if (sub === 'additem') {
      const name = interaction.options.getString('name', true);
      const price = interaction.options.getInteger('price', true);
      const description = interaction.options.getString('description');
      const role = interaction.options.getRole('role');
      const result = db
        .prepare('INSERT INTO shop_items (guild_id, name, description, price, role_id) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, name, description ?? null, price, role?.id ?? null);
      await interaction.reply({ content: `商品を追加した。ID: **${result.lastInsertRowid}**`, ephemeral: true });
      return;
    }

    if (sub === 'addstock') {
      const itemId = interaction.options.getInteger('item_id', true);
      const payload = interaction.options.getString('payload', true);
      const item = db.prepare('SELECT * FROM shop_items WHERE id = ? AND guild_id = ?').get(itemId, guildId);
      if (!item) {
        await interaction.reply({ content: '商品が見つからない。', ephemeral: true });
        return;
      }
      db.prepare('INSERT INTO shop_stock (item_id, payload) VALUES (?, ?)').run(itemId, payload);
      await interaction.reply({ content: `商品 #${itemId} に在庫を1件追加した。`, ephemeral: true });
      return;
    }

    if (sub === 'removeitem') {
      const itemId = interaction.options.getInteger('item_id', true);
      db.prepare('UPDATE shop_items SET active = 0 WHERE id = ? AND guild_id = ?').run(itemId, guildId);
      await interaction.reply({ content: `商品 #${itemId} を非公開にした。`, ephemeral: true });
      return;
    }
  },
};

export default command;
