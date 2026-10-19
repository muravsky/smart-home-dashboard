/* ==========================================================================
   Smart Home Dashboard — Modular Kiosk Enhancements
   - Offline Service Worker registration
   - Screen Wake Lock API manager (keeps display awake while active, releases in night/sleep)
   - Smart Shopping List aisle categorization & grouping
   - Scoped Socket.IO delta patcher
   ========================================================================== */
(function (global) {
  'use strict';

  const AISLE_META = {
    Produce: { icon: '🥬', order: 1, label: 'Produce' },
    Dairy: { icon: '🥛', order: 2, label: 'Dairy & Eggs' },
    Bakery: { icon: '🥖', order: 3, label: 'Bakery' },
    Meat: { icon: '🥩', order: 4, label: 'Meat & Seafood' },
    Pantry: { icon: '🥫', order: 5, label: 'Pantry & Dry Goods' },
    Household: { icon: '🧻', order: 6, label: 'Household' },
    Other: { icon: '🛒', order: 7, label: 'Other' }
  };

  function inferShoppingCategory(rawText) {
    const s = String(rawText || '').toLowerCase();
    if (!s) return 'Other';
    if (/milk|egg|cheese|parmesan|mozzarella|yogurt|butter|cream|cottage|sour cream|kefir/.test(s)) return 'Dairy';
    if (/apple|banana|berry|berries|blueberry|strawberry|lemon|lime|orange|lettuce|romaine|spinach|broccoli|carrot|onion|garlic|tomato|potato|cucumber|pepper|avocado|herb|basil|parsley|dill|fruit|veg|salad|mushroom|zucchini/.test(s)) return 'Produce';
    if (/bread|sourdough|bun|roll|crouton|bagel|tortilla|pita|pastry|croissant|muffin/.test(s)) return 'Bakery';
    if (/chicken|beef|pork|salmon|fish|turkey|bacon|sausage|meat|steak|ham|shrimp|tuna|minced/.test(s)) return 'Meat';
    if (/soap|detergent|paper|towel|trash|bag|sponge|battery|batteries|cleaner|toothpaste|shampoo|tissue|foil|wrap/.test(s)) return 'Household';
    if (/flour|sugar|salt|oil|olive|pasta|spaghetti|lasagna|rice|oat|cereal|syrup|maple|sauce|dressing|bean|soup|spice|coffee|tea|honey|nut|peanut|jam|vinegar|ketchup|mustard|mayo|chocolate|snack/.test(s)) return 'Pantry';
    return 'Other';
  }

  function groupShoppingItemsByAisle(items = []) {
    const groupsMap = new Map();
    for (const item of items) {
      if (!item) continue;
      const cat = item.category || inferShoppingCategory(item.content);
      const meta = AISLE_META[cat] || AISLE_META.Other;
      if (!groupsMap.has(cat)) {
        groupsMap.set(cat, {
          category: cat,
          icon: meta.icon,
          label: meta.label,
          order: meta.order,
          items: []
        });
      }
      groupsMap.get(cat).items.push(item);
    }
    return Array.from(groupsMap.values()).sort((a, b) => a.order - b.order);
  }

  const WakeLockManager = {
    sentinel: null,
    desiredActive: true,

    async acquire() {
      this.desiredActive = true;
      if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return false;
      if (document.visibilityState !== 'visible') return false;
      if (this.sentinel && !this.sentinel.released) return true;
      try {
        this.sentinel = await navigator.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => {
          this.sentinel = null;
        });
        return true;
      } catch (err) {
        return false;
      }
    },

    async release() {
      this.desiredActive = false;
      if (!this.sentinel) return;
      try {
        await this.sentinel.release();
      } catch (err) {
        // Ignore release errors
      } finally {
        this.sentinel = null;
      }
    },

    sync({ sleeping = false, nightModeActive = false } = {}) {
      if (sleeping || nightModeActive) {
        this.release();
      } else {
        this.acquire();
      }
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && WakeLockManager.desiredActive) {
        WakeLockManager.acquire();
      }
    });
  }

  function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  function applyDashboardDelta(target, delta) {
    if (!target || !delta || typeof delta !== 'object') return false;
    const { section, data } = delta;
    if (!section || data === undefined) return false;

    if (section === 'lists' && Array.isArray(data)) {
      target.lists = data;
      return true;
    }
    if (section === 'notes' && Array.isArray(data)) {
      target.notes = data;
      return true;
    }
    if (section === 'tasks' && Array.isArray(data)) {
      target.tasks = data;
      return true;
    }
    if (section === 'events' && Array.isArray(data)) {
      target.events = data;
      return true;
    }
    if (section === 'dishes' && Array.isArray(data)) {
      target.dishes = data;
      return true;
    }
    if (section === 'meal_menus' && Array.isArray(data)) {
      target.meal_menus = data;
      return true;
    }
    if (section === 'profiles' && Array.isArray(data)) {
      target.profiles = data;
      return true;
    }
    if (section === 'rewards' && data && typeof data === 'object') {
      if (Array.isArray(data.rewards)) target.rewards = data.rewards;
      if (Array.isArray(data.reward_redemptions)) target.reward_redemptions = data.reward_redemptions;
      if (Array.isArray(data.profiles)) target.profiles = data.profiles;
      return true;
    }
    return false;
  }

  registerServiceWorker();

  global.KioskEnhancements = {
    AISLE_META,
    inferShoppingCategory,
    groupShoppingItemsByAisle,
    WakeLockManager,
    registerServiceWorker,
    applyDashboardDelta
  };
})(typeof window !== 'undefined' ? window : globalThis);
