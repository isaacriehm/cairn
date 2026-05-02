import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type TextChannel,
} from "discord.js";

/**
 * Channel-per-task lifecycle per L09 + `WORKFLOW_GUIDE` §0:
 *   📋 backlog  — proposed but not dispatched
 *   🟢 active   — task in flight
 *   📦 archive  — task closed (locked for writes)
 */
export const CATEGORY_NAMES = {
  backlog: "📋 backlog",
  active: "🟢 active",
  archive: "📦 archive",
} as const;

export type CategoryKey = keyof typeof CATEGORY_NAMES;

export async function ensureCategories(
  guild: Guild,
): Promise<Record<CategoryKey, CategoryChannel>> {
  const result = {} as Record<CategoryKey, CategoryChannel>;
  for (const key of Object.keys(CATEGORY_NAMES) as CategoryKey[]) {
    const name = CATEGORY_NAMES[key];
    const existing = guild.channels.cache.find(
      (c): c is CategoryChannel =>
        c.type === ChannelType.GuildCategory && c.name === name,
    );
    if (existing) {
      result[key] = existing;
      continue;
    }
    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
    });
    result[key] = created;
  }
  return result;
}

/**
 * Slugify task body to a channel-safe suffix. Discord channel names allow
 * lowercase letters, digits, and hyphens; max 100 chars total.
 */
export function slugifyForChannel(body: string, max = 40): string {
  const cleaned = body
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (cleaned.length === 0) return "task";
  return cleaned.slice(0, max);
}

export async function createTaskChannel(args: {
  guild: Guild;
  category: CategoryChannel;
  taskId: string;
  bodySlug: string;
}): Promise<TextChannel> {
  const { guild, category, taskId, bodySlug } = args;
  const name = `task-${bodySlug}-${taskId}`.slice(0, 95);
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
  });
  return channel as TextChannel;
}

export async function moveChannelToCategory(args: {
  channel: TextChannel;
  category: CategoryChannel;
}): Promise<void> {
  const { channel, category } = args;
  await channel.setParent(category.id, { lockPermissions: true });
}
