import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands/index.js';

const rest = new REST().setToken(config.token);
const body = commands.map((c) => c.data.toJSON());

async function main() {
  if (config.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), { body });
    console.log(`Deployed ${body.length} commands to guild ${config.devGuildId}`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    console.log(`Deployed ${body.length} global commands`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
