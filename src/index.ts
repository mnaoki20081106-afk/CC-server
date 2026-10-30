import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import * as interactionCreate from './events/interactionCreate.js';
import * as messageSecurity from './events/messageSecurity.js';
import { guildMemberAdd, guildMemberRemove } from './events/memberEvents.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

client.once('ready', (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on('interactionCreate', interactionCreate.execute);
client.on('messageCreate', messageSecurity.execute);
client.on('guildMemberAdd', guildMemberAdd.execute);
client.on('guildMemberRemove', guildMemberRemove.execute);

client.login(config.token);
