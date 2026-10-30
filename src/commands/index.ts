import type { Command } from '../types.js';
import setup from './setup.js';
import servermanage from './servermanage.js';
import security from './security.js';
import verify from './verify.js';
import welcome from './welcome.js';
import ticket from './ticket.js';
import panel from './panel.js';
import economy from './economy.js';
import shop from './shop.js';
import backup from './backup.js';
import amazonVending from './amazon-vending.js';

export const commands: Command[] = [setup, servermanage, security, verify, welcome, ticket, panel, economy, shop, backup, amazonVending];
