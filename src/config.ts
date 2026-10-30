import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  devGuildId: process.env.DEV_GUILD_ID || null,
  dbPath: process.env.DB_PATH || './data/bot.sqlite',
  backupDir: process.env.BACKUP_DIR || './data/backups',
};
