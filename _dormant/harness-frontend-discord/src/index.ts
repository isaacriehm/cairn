/**
 * @isaacriehm/harness-frontend-discord — Discord adapter.
 *
 * See docs/ARCHITECTURE.md §3.3.
 */

export {
  DiscordFrontendAdapter,
  type DiscordFrontendAdapterOptions,
} from "./discord/index.js";
export { isOwner, parseOwnerIds } from "./discord/acl.js";
export {
  CATEGORY_NAMES,
  createTaskChannel,
  ensureCategories,
  moveChannelToCategory,
  slugifyForChannel,
  type CategoryKey,
} from "./discord/channels.js";
export { classifyFreeText } from "./discord/classifier.js";
export {
  buildSlashCommands,
  registerSlashCommands,
  SLASH_COMMAND_NAMES,
  type SlashCommandName,
} from "./discord/slash.js";
