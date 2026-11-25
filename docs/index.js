(function () {
function require(id) {
  switch (id) {
    case "@vendetta": return vendetta;
    case "@vendetta/patcher": return vendetta.patcher;
    case "@vendetta/metro": return vendetta.metro;
    case "@vendetta/metro/common": return vendetta.metro.common;
    case "@vendetta/utils": return vendetta.utils;
    case "@vendetta/ui": return vendetta.ui;
    case "@vendetta/ui/assets": return vendetta.ui.assets;
    case "@vendetta/ui/toasts": return vendetta.ui.toasts;
    case "@vendetta/ui/components": return vendetta.ui.components;
    case "@vendetta/storage": return vendetta.storage;
    case "@vendetta/plugin": return vendetta.plugin;
    case "@vendetta/commands": return vendetta.commands;
    default: throw new Error("[LeaveThreads] Unknown module: " + id);
  }
}
var module = { exports: {} };
var exports = module.exports;

var import_patcher = require("@vendetta/patcher");
var import_common = require("@vendetta/metro/common");
var import_metro = require("@vendetta/metro");
var import_toasts = require("@vendetta/ui/toasts");
var import_assets = require("@vendetta/ui/assets");
var import_components = require("@vendetta/ui/components");
var import_plugin = require("@vendetta/plugin");

var React = import_common.React;
var RN = import_common.ReactNative;
var { View, Pressable, StyleSheet, Image, Text, ScrollView } = RN;
var storage = import_plugin.storage;

var TAG = "[LeaveThreads]";
var TILE = 48;
var MARGIN = 4;
var Haptic = (0, import_metro.findByProps)("triggerHapticFeedback", "HapticFeedbackTypes");

// ---------------------------------------------------------------- helpers
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));

var toast = (msg, icon) => {
  try {
    (0, import_toasts.showToast)(msg, icon ? (0, import_assets.getAssetIDByName)(icon) : void 0);
  } catch (e) {
    console.log(TAG, msg);
  }
};

var getStores = () => ({
  ChannelStore: (0, import_metro.findByStoreName)("ChannelStore"),
  UserStore: (0, import_metro.findByStoreName)("UserStore"),
  GuildStore: (0, import_metro.findByStoreName)("GuildStore"),
  JoinedThreadsStore: (0, import_metro.findByStoreName)("JoinedThreadsStore"),
  FluxDispatcher: (0, import_metro.findByProps)("dispatch", "subscribe") || import_common.FluxDispatcher
});

var getRest = () =>
  (0, import_metro.findByProps)("getAPIBaseURL", "get") || (0, import_metro.findByProps)("getAPIBaseURL");

var getParentId = () => String(storage.parentId || "").trim();
var isAutoOn = () => storage.autoLeave !== false;
var isValidId = (s) => /^\d{15,25}$/.test(s);

var TRASH_CANDIDATES = [
  "TrashIcon", "ic_trash_24px", "ic_trash", "trash", "ic_message_delete",
  "ic_delete_24px", "Trash", "ic_delete"
];
var getTrashAsset = () => {
  for (const name of TRASH_CANDIDATES) {
    try {
      const id = (0, import_assets.getAssetIDByName)(name);
      if (id) return id;
    } catch (e) {
    }
  }
  return null;
};

// ---------------------------------------------------------------- leaving threads
var session = null;
var sweeping = false;
var pending = new Set();
var drainTimer;

// DELETE /channels/{thread}/thread-members/@me
async function leaveThread(threadId) {
  const api = getRest();
  if (!api) return false;
  const del = api.del || api.delete;
  if (!del) return false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await del.call(api, { url: `/channels/${threadId}/thread-members/@me` });
      return true;
    } catch (e) {
      const status = e?.status ?? e?.statusCode;
      const retry = e?.body?.retry_after;
      if (status === 429 && retry) {
        await sleep(Math.ceil(retry * 1000) + 150);
        continue;
      }
      // 404 / 10065 = already not a member -> nothing left to do
      if (status === 404) return true;
      console.log(TAG, "Failed to leave", threadId, status, e?.body ?? e);
      return false;
    }
  }
  return false;
}

// every thread under the parent channel that the user has joined
function collectJoinedThreads(parentId) {
  const { ChannelStore, JoinedThreadsStore } = getStores();
  const ids = /* @__PURE__ */ new Set();
  const parent = ChannelStore?.getChannel?.(parentId);
  const guildId = parent?.guild_id;
  try {
    const joined = JoinedThreadsStore?.getJoinedThreadsForParent?.(guildId, parentId);
    if (Array.isArray(joined)) joined.forEach((t) => ids.add(t?.id ?? t));
    else if (joined && typeof joined === "object") Object.keys(joined).forEach((id) => ids.add(id));
  } catch (e) {
  }
  try {
    const list = ChannelStore?.getAllThreadsForParent?.(parentId);
    (Array.isArray(list) ? list : Object.values(list ?? {})).forEach((t) => {
      const id = t?.id ?? t;
      if (!id) return;
      if (JoinedThreadsStore?.hasJoined && !JoinedThreadsStore.hasJoined(id)) return;
      ids.add(id);
    });
  } catch (e) {
  }
  return [...ids];
}

async function sweep(manual) {
  const parentId = getParentId();
  if (!parentId) {
    if (manual) toast("Set the parent channel ID in the plugin settings first", "Small");
    return;
  }
  const { ChannelStore } = getStores();
  if (!ChannelStore?.getChannel?.(parentId)) {
    if (manual) toast("Channel not found - check the ID", "ic_close_16px");
    return;
  }
  if (sweeping) return;
  sweeping = true;
  const s = session;
  try {
    const ids = collectJoinedThreads(parentId);
    if (ids.length === 0) {
      if (manual) toast("No joined threads found", "Small");
      return;
    }
    if (manual) toast(`Leaving ${ids.length} thread${ids.length === 1 ? "" : "s"}...`, "Small");
    let ok = 0;
    for (const id of ids) {
      if (s && !s.active) break;
      if (await leaveThread(id)) ok++;
      await sleep(700);
    }
    if (manual || ok > 0) toast(`Left ${ok}/${ids.length} thread${ids.length === 1 ? "" : "s"}`, "Check");
  } finally {
    sweeping = false;
  }
}

// auto-leave queue (used by gateway events)
async function drain() {
  drainTimer = void 0;
  const s = session;
  if (!s?.active) return;
  const { JoinedThreadsStore } = getStores();
  while (pending.size > 0 && s.active) {
    if (!isAutoOn()) {
      pending.clear();
      break;
    }
    const id = pending.values().next().value;
    pending.delete(id);
    if (JoinedThreadsStore?.hasJoined && !JoinedThreadsStore.hasJoined(id)) continue;
    await leaveThread(id);
    await sleep(700);
  }
}

function enqueue(threadId, parentHint) {
  if (!session?.active || !isAutoOn()) return;
  const parentId = getParentId();
  if (!parentId || !threadId) return;
  const { ChannelStore } = getStores();
  const parent = parentHint ?? ChannelStore?.getChannel?.(threadId)?.parent_id;
  if (parent !== parentId) return;
  pending.add(threadId);
  if (!drainTimer) drainTimer = setTimeout(drain, 1500); // let the stores update first
}

var myId = () => getStores().UserStore?.getCurrentUser?.()?.id;

var onThreadCreate = (e) => {
  const c = e?.channel;
  if (c?.id) enqueue(c.id, c.parent_id ?? c.parentId);
};
var onMemberUpdate = (e) => {
  if (e?.id) enqueue(e.id);
};
var onMembersUpdate = (e) => {
  const me = myId();
  if (e?.id && e?.addedMembers?.some?.((m) => (m.userId ?? m.user_id) === me)) enqueue(e.id);
};
var onListSync = (e) => {
  (e?.threads || []).forEach((t) => enqueue(t.id, t.parent_id ?? t.parentId));
};
var onConnectionOpen = () => {
  setTimeout(() => {
    if (session?.active && isAutoOn()) sweep(false);
  }, 8e3);
};

// ---------------------------------------------------------------- footer button
var st = StyleSheet.create({
  row: {
    alignSelf: "stretch",
    alignItems: "center",
    paddingTop: MARGIN,
    paddingBottom: MARGIN
  },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 16,
    backgroundColor: "#111214",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden"
  },
  circleBg: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#2B2D31",
    alignItems: "center",
    justifyContent: "center"
  }
});

function LeaveButton() {
  const asset = getTrashAsset();
  const handlePress = () => {
    Haptic?.triggerHapticFeedback?.(Haptic.HapticFeedbackTypes.SOFT);
    sweep(true);
  };
  return React.createElement(
    View,
    { style: st.row },
    React.createElement(
      Pressable,
      { onPress: handlePress, accessibilityRole: "button", accessibilityLabel: "Leave all threads" },
      React.createElement(
        View,
        { style: st.tile },
        React.createElement(
          View,
          { style: st.circleBg },
          asset
            ? React.createElement(Image, { source: asset, style: { width: 24, height: 24, tintColor: "#F23F42" } })
            : React.createElement(Text, { style: { fontSize: 20 } }, "🗑")
        )
      )
    )
  );
}

// ---------------------------------------------------------------- footer patching (same technique as Read All)
var unpatchers = [];
var patchedObjects = /* @__PURE__ */ new WeakSet();
var retryTimer;
var startTimer;

function isUseGuildsBarProps(exp) {
  return typeof exp?.default === "function" && exp.default.name === "useGuildsBarProps";
}

function patchFooter(ret, s) {
  const ldp = ret?.listDataProps;
  if (!ldp || patchedObjects.has(ldp)) return;
  if (typeof ldp.footerSize !== "function" || typeof ldp.renderFooter !== "function") return;
  const origFooterSize = ldp.footerSize;
  const origRenderFooter = ldp.renderFooter;
  const extra = TILE + 2 * MARGIN;
  ldp.footerSize = () => origFooterSize.call(ldp) + (s.active ? extra : 0);
  ldp.renderFooter = () => {
    const orig = origRenderFooter.call(ldp);
    if (!s.active) return orig;
    // appended AFTER whatever was already in the footer -> sits below the Read All button
    return React.createElement(
      View,
      { style: { alignSelf: "stretch" }, collapsable: false },
      orig,
      React.createElement(LeaveButton)
    );
  };
  patchedObjects.add(ldp);
}

function scanRegistry(s) {
  const modules = globalThis?.modules;
  if (!modules) return 0;
  let patchedCount = 0;
  for (const id in modules) {
    const def = modules[id];
    if (!def?.isInitialized) continue;
    const exp = def.publicModule?.exports;
    if (!exp) continue;
    if (isUseGuildsBarProps(exp)) {
      try {
        unpatchers.push((0, import_patcher.after)("default", exp, (_args, ret) => patchFooter(ret, s)));
        patchedCount++;
      } catch (e) {
        console.log(TAG, `Failed to patch module ${id}:`, e);
      }
    }
  }
  return patchedCount;
}

// ---------------------------------------------------------------- settings
function Settings() {
  const Forms = import_components.Forms;
  const [input, setInput] = React.useState(String(storage.parentId || ""));
  const [auto, setAuto] = React.useState(isAutoOn());
  const [, force] = React.useReducer((x) => x + 1, 0);

  const parentName = () => {
    const id = String(storage.parentId || "").trim();
    if (!id) return "No channel set";
    const { ChannelStore, GuildStore } = getStores();
    const ch = ChannelStore?.getChannel?.(id);
    if (!ch) return `Channel not found (${id})`;
    const guild = GuildStore?.getGuild?.(ch.guild_id);
    return `#${ch.name}${guild ? " - " + guild.name : ""}`;
  };

  const handleSave = () => {
    const id = input.trim();
    if (!isValidId(id)) {
      toast("That doesn't look like a channel ID", "ic_close_16px");
      return;
    }
    storage.parentId = id;
    toast("Parent channel saved", "ic_check");
    force();
    if (isAutoOn()) sweep(true);
  };

  const handleToggle = (v) => {
    const next = typeof v === "boolean" ? v : !auto;
    storage.autoLeave = next;
    setAuto(next);
    if (next) {
      if (getParentId()) sweep(true);
    } else {
      pending.clear();
      toast("Automatic leaving threads: OFF", "Small");
    }
  };

  return React.createElement(
    ScrollView,
    { contentContainerStyle: { paddingBottom: 80 } },
    React.createElement(
      Forms.FormSection,
      { title: "Automatic" },
      Forms.FormSwitchRow
        ? React.createElement(Forms.FormSwitchRow, {
            label: "Automatic leaving threads",
            subLabel: "When on, threads under the channel below are left automatically. When off, nothing happens unless you press the trash button.",
            value: auto,
            onValueChange: handleToggle
          })
        : React.createElement(Forms.FormRow, {
            label: `Automatic leaving threads: ${auto ? "ON" : "OFF"}`,
            subLabel: "Tap to turn on/off",
            onPress: () => handleToggle()
          })
    ),
    React.createElement(
      Forms.FormSection,
      { title: "Parent Channel" },
      React.createElement(
        Forms.FormText,
        { style: { marginBottom: 10, marginHorizontal: 16 } },
        "Enter the ID of the forum / text channel whose threads you want to leave, then tap Save. The trash button under your server list always works manually, even with automatic leaving off."
      ),
      React.createElement(Forms.FormInput, {
        title: "Parent channel ID",
        placeholder: "e.g. 1325923169164333178",
        value: input,
        onChange: setInput,
        onSubmitEditing: handleSave,
        keyboardType: "numeric"
      }),
      React.createElement(Forms.FormRow, { label: "Save", subLabel: parentName(), onPress: handleSave })
    ),
    React.createElement(
      Forms.FormSection,
      { title: "Actions" },
      React.createElement(Forms.FormRow, {
        label: "Leave all threads now",
        onPress: () => sweep(true)
      })
    )
  );
}

// ---------------------------------------------------------------- plugin
var EVENTS = {
  THREAD_CREATE: onThreadCreate,
  THREAD_MEMBER_UPDATE: onMemberUpdate,
  THREAD_MEMBERS_UPDATE: onMembersUpdate,
  THREAD_LIST_SYNC: onListSync,
  CONNECTION_OPEN: onConnectionOpen
};

var plugin = {
  onLoad() {
    const s = { active: true };
    session = s;

    const { FluxDispatcher } = getStores();
    for (const type in EVENTS) {
      try {
        FluxDispatcher.subscribe(type, EVENTS[type]);
        unpatchers.push(() => FluxDispatcher.unsubscribe(type, EVENTS[type]));
      } catch (e) {
        console.log(TAG, "Failed to subscribe", type, e);
      }
    }

    // small delay so we register after "Read All" -> our button ends up underneath it
    startTimer = setTimeout(() => {
      startTimer = void 0;
      if (!s.active) return;
      const count = scanRegistry(s);
      if (count === 0) {
        let ticks = 0;
        retryTimer = setInterval(() => {
          ticks++;
          const n = scanRegistry(s);
          if (n > 0 || ticks >= 30) {
            if (retryTimer) clearInterval(retryTimer);
            retryTimer = void 0;
          }
        }, 1e3);
      }
    }, 1500);

    // initial sweep once the stores are populated
    setTimeout(() => {
      if (s.active && isAutoOn() && getParentId()) sweep(false);
    }, 5e3);
  },
  onUnload() {
    if (session) session.active = false;
    session = null;
    pending.clear();
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = void 0;
    if (startTimer) clearTimeout(startTimer);
    startTimer = void 0;
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = void 0;
    unpatchers.forEach((u) => {
      try { u(); } catch (e) { }
    });
    unpatchers = [];
  },
  settings: Settings
};

module.exports = { __esModule: true, default: plugin };

return module.exports;
})();
