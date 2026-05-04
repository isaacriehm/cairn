/**
 * @isaacriehm/harness-frontend-discord — Discord frontend adapter.
 *
 * SKELETON: this file will become the public API surface once the file
 * moves land. See docs/ARCHITECTURE.md §3.3 for what belongs here, and
 * RESUME_PROMPT.md for the migration plan.
 *
 * Expected exports (post-move):
 *   - DiscordFrontendAdapter class implementing FrontendAdapter from core
 *   - channels/: ensureCategories, createTaskChannel, moveChannelToCategory,
 *     slugifyForChannel, CATEGORY_NAMES, CategoryKey
 *   - slash/: registerSlashCommands, SLASH_COMMAND_NAMES, buildSlashCommands
 *   - acl/: parseOwnerIds, isOwner
 *   - voice/: transcribeUrl, whisperModelExists (Whisper pipeline)
 *   - embed builder + phase color/emoji map
 */

export const __SKELETON__ = "harness-frontend-discord";
