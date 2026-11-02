'use strict';

/**
 * Keeps Discord channels in order:
 *  - talkgroup channels inside each category sorted A→Z (natural order, so
 *    "Krimmel 2" comes before "Krimmel 10")
 *  - pinned categories (DISCORD_PINNED_CATEGORIES, "|"-separated, in order) at
 *    the top of the server; every other category keeps its current order
 *
 * Only the bot's own talkgroup channels move. Hand-made channels, the dispatch
 * summary and alert channels keep their places, and the talkgroup channels are
 * sorted among the remaining slots. Each category is one bulk Discord request,
 * and nothing is sent when the order is already right.
 */

const { ChannelType } = require('discord.js');

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Is this one of the bot's talkgroup channels? (They carry this topic.) */
function isTalkgroupChannel(ch) {
  return ch.type === ChannelType.GuildText && String(ch.topic || '').startsWith('Transcriptions for ');
}

function pos(ch) {
  return ch.rawPosition != null ? ch.rawPosition : (ch.position || 0);
}

function byPosition(a, b) {
  return pos(a) - pos(b) || String(a.id).localeCompare(String(b.id));
}

/**
 * Work out the new order for one category's text channels.
 * Returns [{ channel, position }] for the channels whose position changes,
 * or [] when the order is already right.
 */
function planCategorySort(children) {
  const ordered = children.slice().sort(byPosition);
  const movable = ordered.filter(isTalkgroupChannel);
  if (movable.length < 2) return [];
  const sorted = movable.slice().sort((a, b) => collator.compare(a.name, b.name) || String(a.id).localeCompare(String(b.id)));
  // Talkgroup channels take the talkgroup channels' slots in A→Z order;
  // anything else stays where it is.
  let k = 0;
  const desired = ordered.map((ch) => (isTalkgroupChannel(ch) ? sorted[k++] : ch));
  return assignPositions(ordered, desired);
}

/**
 * Work out the new order for the server's categories: pinned names first, in
 * the given order (case-insensitive), then the rest in their current order.
 */
function planCategoryOrder(categories, pinnedNames) {
  const ordered = categories.slice().sort(byPosition);
  const pins = (pinnedNames || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  if (!pins.length || ordered.length < 2) return [];
  const pinned = [];
  for (const name of pins) {
    const cat = ordered.find((c) => c.name.trim().toLowerCase() === name && !pinned.includes(c));
    if (cat) pinned.push(cat);
  }
  if (!pinned.length) return [];
  const desired = [...pinned, ...ordered.filter((c) => !pinned.includes(c))];
  return assignPositions(ordered, desired);
}

/**
 * Give `desired` the positions `current` occupies now. When those positions
 * aren't distinct (Discord sometimes has ties), number them from the lowest.
 */
function assignPositions(current, desired) {
  if (current.every((ch, i) => ch === desired[i])) return [];
  let slots = current.map(pos);
  if (new Set(slots).size !== slots.length) slots = slots.map((_, i) => slots[0] + i);
  else slots.sort((a, b) => a - b);
  const out = [];
  desired.forEach((ch, i) => { if (pos(ch) !== slots[i] || current[i] !== ch) out.push({ channel: ch.id, position: slots[i] }); });
  return out;
}

function parsePinned(value) {
  return String(value || '').split('|').map((s) => s.trim()).filter(Boolean);
}

function sortEnabled(env = process.env) {
  return String(env.DISCORD_SORT_CHANNELS ?? 'true').toLowerCase() !== 'false';
}

/**
 * Wires ordering into the bot. getGuild() returns the guild (or null),
 * logger is the bot's logger.
 */
function createChannelOrderer({ getGuild, logger, delayMs = 5000 }) {
  const pendingCategories = new Set();
  let timer = null;
  let categoriesPending = false;
  let running = Promise.resolve();

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function sortCategory(guild, categoryId) {
    const children = Array.from(guild.channels.cache.filter((ch) => ch.parentId === categoryId && ch.type === ChannelType.GuildText).values());
    const plan = planCategorySort(children);
    if (!plan.length) return 0;
    await guild.channels.setPositions(plan);
    return plan.length;
  }

  async function orderCategories(guild) {
    const cats = Array.from(guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildCategory).values());
    const plan = planCategoryOrder(cats, parsePinned(process.env.DISCORD_PINNED_CATEGORIES));
    if (!plan.length) return 0;
    await guild.channels.setPositions(plan);
    return plan.length;
  }

  // Runs one job at a time so two sorts never interleave their requests.
  function enqueue(fn) {
    running = running.then(fn).catch((e) => logger.warn(`[discord] channel ordering failed: ${e.message}`));
    return running;
  }

  function flush() {
    timer = null;
    const ids = Array.from(pendingCategories);
    pendingCategories.clear();
    const doCats = categoriesPending;
    categoriesPending = false;
    return enqueue(async () => {
      const guild = getGuild();
      if (!guild) return;
      if (doCats) await orderCategories(guild);
      if (!sortEnabled()) return;
      for (const id of ids) {
        await sortCategory(guild, id);
        if (ids.length > 1) await pause(600);
      }
    });
  }

  function schedule() {
    if (!timer) timer = setTimeout(flush, delayMs);
  }

  return {
    /** A channel was created in this category: sort it shortly (debounced). */
    channelAdded(categoryId) {
      if (!categoryId || !sortEnabled()) return;
      pendingCategories.add(categoryId);
      schedule();
    },
    /** A category was created or the pinned list changed: re-pin shortly. */
    categoriesChanged() {
      categoriesPending = true;
      schedule();
    },
    /**
     * Sort every category's channels (even when automatic sorting is off; this
     * is the Settings button) and apply the pinned categories.
     * Resolves with { categories, moved }.
     */
    sortAll({ force = false } = {}) {
      return enqueue(async () => {
        const guild = getGuild();
        if (!guild) return { categories: 0, moved: 0 };
        let moved = await orderCategories(guild);
        let touched = 0;
        if (force || sortEnabled()) {
          const cats = guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildCategory);
          for (const cat of cats.values()) {
            const n = await sortCategory(guild, cat.id);
            if (n) { moved += n; touched += 1; await pause(600); }
          }
        }
        if (moved) logger.info(`[discord] reordered ${moved} channel(s) in ${touched} category(ies)`);
        return { categories: touched, moved };
      });
    },
  };
}

module.exports = {
  createChannelOrderer,
  planCategorySort,
  planCategoryOrder,
  parsePinned,
  sortEnabled,
  isTalkgroupChannel,
};
