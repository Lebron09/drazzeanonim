(function () {
  "use strict";

  const PEER_OPTIONS = {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
    debug: 0,
  };

  const GUEST_FAIL_MAX = 40;
  const RECENT_KEY = "drazze_recent_v2";
  const PROFILE_KEY = "drazze_profile";
  const SETTINGS_KEY = "drazze_settings";

  const STR = {
    ru: {
      chats: "Чаты",
      calls: "Звонки",
      contacts: "Контакты",
      profile: "Профиль",
      peerFallback: "Собеседник",
      inviteCopied: "Ссылка скопирована.",
      inviteManual: "Скопируйте вручную: ",
      appInvite: "Приглашение в DrazzeAnonim: ",
    },
    en: {
      chats: "Chats",
      calls: "Calls",
      contacts: "Contacts",
      profile: "Profile",
      peerFallback: "Peer",
      inviteCopied: "Link copied.",
      inviteManual: "Copy manually: ",
      appInvite: "Join DrazzeAnonim: ",
    },
  };

  let lang = "ru";
  function t(k) {
    return (STR[lang] && STR[lang][k]) || STR.ru[k] || k;
  }

  /** @type {Peer | null} */
  let peer = null;
  /** @type {import("peerjs").DataConnection | null} */
  let dataConn = null;
  /** @type {import("peerjs").MediaConnection | null} */
  let mediaCall = null;
  let localStream = null;

  let isHost = false;
  /** @type {string | null} */
  let roomIdActive = null;
  /** @type {string | null} */
  let callTargetId = null;

  let displayName = "";
  let peerDisplayName = "";

  let guestConnectFailures = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let guestRetryTimer = null;

  const cryptoState = {
    keyPair: null,
    peerPublic: null,
    aesKey: null,
    ready: false,
  };
  let pendingPeerHs = null;

  const appEl = document.getElementById("app");
  const paneShell = document.getElementById("pane-shell");
  const paneChat = document.getElementById("pane-chat");

  const els = {
    viewChats: document.getElementById("view-chats"),
    viewCalls: document.getElementById("view-calls"),
    viewContacts: document.getElementById("view-contacts"),
    viewProfile: document.getElementById("view-profile"),
    chatList: document.getElementById("chat-list"),
    chatListSearch: document.getElementById("chat-list-search"),
    contactsSearch: document.getElementById("contacts-search"),
    contactsList: document.getElementById("contacts-list"),
    newChatDrawer: document.getElementById("new-chat-drawer"),
    btnToggleNew: document.getElementById("btn-toggle-new"),
    inputName: document.getElementById("input-name"),
    inputRoom: document.getElementById("input-room"),
    inputMessage: document.getElementById("input-message"),
    btnCreate: document.getElementById("btn-create"),
    btnJoin: document.getElementById("btn-join"),
    btnCopy: document.getElementById("btn-copy-link"),
    btnCall: document.getElementById("btn-call"),
    btnHangup: document.getElementById("btn-hangup"),
    btnBack: document.getElementById("btn-back"),
    btnSend: document.getElementById("btn-send"),
    formSend: document.getElementById("form-send"),
    messages: document.getElementById("messages"),
    roomIdDisplay: document.getElementById("room-id-display"),
    connStatus: document.getElementById("conn-status"),
    lobbyError: document.getElementById("lobby-error"),
    roomHint: document.getElementById("room-hint"),
    callDock: document.getElementById("call-dock"),
    videoLocal: document.getElementById("video-local"),
    videoRemote: document.getElementById("video-remote"),
    chatPeerTitle: document.getElementById("chat-peer-title"),
    profileNick: document.getElementById("profile-nick"),
    profileBio: document.getElementById("profile-bio"),
    profileAvatar: document.getElementById("profile-avatar"),
    btnSaveProfile: document.getElementById("btn-save-profile"),
    btnInviteRef: document.getElementById("btn-invite-ref"),
    setNotifyChat: document.getElementById("set-notify-chat"),
    setNotifyCall: document.getElementById("set-notify-call"),
    setLang: document.getElementById("set-lang"),
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (els.setNotifyChat && typeof s.notifyChat === "boolean") els.setNotifyChat.checked = s.notifyChat;
      if (els.setNotifyCall && typeof s.notifyCall === "boolean") els.setNotifyCall.checked = s.notifyCall;
      if (s.lang === "en" || s.lang === "ru") {
        lang = s.lang;
        if (els.setLang) els.setLang.value = lang;
        applyLangToNav();
      }
    } catch (_) {}
  }

  function saveSettings() {
    const s = {
      notifyChat: els.setNotifyChat ? els.setNotifyChat.checked : true,
      notifyCall: els.setNotifyCall ? els.setNotifyCall.checked : true,
      lang: lang,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function applyLangToNav() {
    document.documentElement.lang = lang;
    document.querySelectorAll(".nav-item[data-nav]").forEach((btn) => {
      const k = btn.getAttribute("data-nav");
      const label = btn.querySelector(".nav-t");
      if (!label) return;
      if (k === "chats") label.textContent = t("chats");
      if (k === "calls") label.textContent = t("calls");
      if (k === "contacts") label.textContent = t("contacts");
      if (k === "profile") label.textContent = t("profile");
    });
  }

  function notifyAllowed(kind) {
    if (kind === "call" && els.setNotifyCall && !els.setNotifyCall.checked) return false;
    if (kind === "chat" && els.setNotifyChat && !els.setNotifyChat.checked) return false;
    return true;
  }

  function loadProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.nick && els.profileNick) els.profileNick.value = p.nick;
      if (p.bio != null && els.profileBio) els.profileBio.value = p.bio;
      syncNameFromProfile();
      updateProfileAvatar();
    } catch (_) {}
  }

  function saveProfile() {
    const p = {
      nick: (els.profileNick && els.profileNick.value.trim()) || "",
      bio: (els.profileBio && els.profileBio.value.trim()) || "",
    };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    syncNameFromProfile();
    updateProfileAvatar();
  }

  function syncNameFromProfile() {
    const nick = els.profileNick ? els.profileNick.value.trim() : "";
    if (els.inputName) els.inputName.value = nick || els.inputName.value;
  }

  function updateProfileAvatar() {
    const nick = els.profileNick ? els.profileNick.value.trim() : "";
    const letter = (nick || "?").charAt(0).toUpperCase();
    if (els.profileAvatar) els.profileAvatar.textContent = letter;
  }

  function loadRecent() {
    try {
      const raw = sessionStorage.getItem(RECENT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveRecent(list) {
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 30)));
  }

  function upsertRecent(entry) {
    let list = loadRecent();
    list = list.filter((x) => x.id !== entry.id);
    list.unshift({
      id: entry.id,
      title: entry.title || entry.id,
      lastText: entry.lastText || "",
      ts: entry.ts || Date.now(),
    });
    saveRecent(list);
    renderChatList();
    renderContacts();
  }

  function shortRoom(id) {
    if (!id || id.length < 10) return id || "";
    return id.slice(0, 6) + "…";
  }

  function renderChatList() {
    if (!els.chatList) return;
    const q = (els.chatListSearch && els.chatListSearch.value.trim().toLowerCase()) || "";
    const list = loadRecent().filter((x) => !q || (x.title && x.title.toLowerCase().includes(q)) || (x.id && x.id.toLowerCase().includes(q)));
    els.chatList.innerHTML = "";
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "tg-hint-list";
      li.style.listStyle = "none";
      li.textContent = lang === "en" ? "No chats yet. Tap + to start." : "Чатов пока нет. Нажмите ＋ чтобы начать.";
      els.chatList.appendChild(li);
      return;
    }
    list.forEach((item) => {
      const li = document.createElement("li");
      li.className = "chat-list-item";
      li.setAttribute("role", "listitem");
      const av = document.createElement("div");
      av.className = "chat-avatar";
      av.textContent = (item.title || item.id).charAt(0).toUpperCase();
      const body = document.createElement("div");
      body.className = "chat-item-body";
      const title = document.createElement("div");
      title.className = "chat-item-title";
      title.textContent = item.title || item.id;
      const sub = document.createElement("div");
      sub.className = "chat-item-sub";
      sub.textContent = item.lastText || item.id;
      body.appendChild(title);
      body.appendChild(sub);
      li.appendChild(av);
      li.appendChild(body);
      li.addEventListener("click", () => {
        if (els.inputRoom) els.inputRoom.value = item.id;
        joinRoom(item.id);
      });
      els.chatList.appendChild(li);
    });
  }

  function renderContacts() {
    if (!els.contactsList) return;
    const q = (els.contactsSearch && els.contactsSearch.value.trim().toLowerCase()) || "";
    const list = loadRecent().filter((x) => !q || (x.title && x.title.toLowerCase().includes(q)) || (x.id && x.id.toLowerCase().includes(q)));
    els.contactsList.innerHTML = "";
    list.forEach((item) => {
      const li = document.createElement("li");
      li.className = "chat-list-item";
      const av = document.createElement("div");
      av.className = "chat-avatar";
      av.textContent = (item.title || item.id).charAt(0).toUpperCase();
      const body = document.createElement("div");
      body.className = "chat-item-body";
      const title = document.createElement("div");
      title.className = "chat-item-title";
      title.textContent = item.title || item.id;
      const sub = document.createElement("div");
      sub.className = "chat-item-sub";
      sub.textContent = item.id;
      body.appendChild(title);
      body.appendChild(sub);
      li.appendChild(av);
      li.appendChild(body);
      li.addEventListener("click", () => joinRoom(item.id));
      els.contactsList.appendChild(li);
    });
  }

  function navigateTo(tab) {
    ["chats", "calls", "contacts", "profile"].forEach((name) => {
      const v = document.getElementById("view-" + name);
      if (v) v.classList.toggle("hidden", name !== tab);
    });
    document.querySelectorAll(".nav-item[data-nav]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-nav") === tab);
    });
  }

  function makeRoomId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `dra${hex}`;
  }

  function parseRoomFromHash() {
    const h = window.location.hash.replace(/^#/, "").trim();
    return h || null;
  }

  function b64(u8) {
    let s = "";
    u8.forEach((c) => {
      s += String.fromCharCode(c);
    });
    return btoa(s);
  }

  function ub64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function showLobbyError(msg) {
    els.lobbyError.hidden = !msg;
    els.lobbyError.textContent = msg || "";
  }

  function setInviteMode(roomFromHash) {
    els.inputRoom.value = roomFromHash;
    els.inputRoom.readOnly = true;
    els.btnCreate.hidden = true;
  }

  function openChatPane() {
    appEl.classList.add("in-chat");
    paneChat.classList.remove("hidden");
    paneChat.setAttribute("aria-hidden", "false");
  }

  function closeChatPane() {
    appEl.classList.remove("in-chat");
    paneChat.classList.add("hidden");
    paneChat.setAttribute("aria-hidden", "true");
  }

  function clearGuestRetry() {
    if (guestRetryTimer) {
      clearTimeout(guestRetryTimer);
      guestRetryTimer = null;
    }
  }

  function showRoomScreen(id) {
    peerDisplayName = t("peerFallback");
    if (els.chatPeerTitle) els.chatPeerTitle.textContent = peerDisplayName;
    openChatPane();
    els.roomIdDisplay.textContent = id;
    setConnStatus("wait", "…");
    els.messages.innerHTML = "";
    els.inputMessage.value = "";
    els.inputMessage.disabled = true;
    els.btnSend.disabled = true;
    guestConnectFailures = 0;
    clearGuestRetry();
  }

  function showLobbyScreen() {
    closeChatPane();
    els.connStatus.className = "conn-pill conn-wait";
    els.roomHint.hidden = true;
    els.inputRoom.readOnly = false;
    els.btnCreate.hidden = false;
    resetVideosUi();
    renderChatList();
  }

  function setConnStatus(kind, text) {
    els.connStatus.textContent = text;
    els.connStatus.className = "conn-pill " + (kind === "ok" ? "conn-ok" : kind === "err" ? "conn-err" : "conn-wait");
  }

  function resetCrypto() {
    cryptoState.keyPair = null;
    cryptoState.peerPublic = null;
    cryptoState.aesKey = null;
    cryptoState.ready = false;
    pendingPeerHs = null;
  }

  function hideCallDock() {
    els.callDock.classList.add("hidden");
    els.callDock.setAttribute("aria-hidden", "true");
  }

  function showCallDock() {
    els.callDock.classList.remove("hidden");
    els.callDock.setAttribute("aria-hidden", "false");
  }

  function resetVideosUi() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    els.videoLocal.srcObject = null;
    els.videoRemote.srcObject = null;
    mediaCall = null;
    hideCallDock();
    els.btnHangup.classList.add("hidden");
    els.btnCall.classList.remove("hidden");
  }

  function cleanupCall() {
    if (mediaCall) {
      try {
        mediaCall.close();
      } catch (_) {}
      mediaCall = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    els.videoLocal.srcObject = null;
    els.videoRemote.srcObject = null;
    hideCallDock();
    els.btnHangup.classList.add("hidden");
    els.btnCall.classList.remove("hidden");
  }

  function leaveRoom() {
    clearGuestRetry();
    guestConnectFailures = 0;
    cleanupCall();
    resetCrypto();
    peerDisplayName = "";
    if (dataConn) {
      try {
        dataConn.close();
      } catch (_) {}
      dataConn = null;
    }
    if (peer) {
      try {
        peer.destroy();
      } catch (_) {}
      peer = null;
    }
    isHost = false;
    roomIdActive = null;
    callTargetId = null;
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    showLobbyScreen();
    navigateTo("chats");
  }

  function addSystemLine(text) {
    if (!notifyAllowed("chat")) return;
    const row = document.createElement("div");
    row.className = "msg-row msg-system-wrap";
    const div = document.createElement("div");
    div.className = "msg-system";
    div.textContent = text;
    row.appendChild(div);
    els.messages.appendChild(row);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addChatLine(who, text, outgoing) {
    const row = document.createElement("div");
    row.className = "msg-row " + (outgoing ? "msg-row-out" : "msg-row-in");
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble " + (outgoing ? "msg-bubble-out" : "msg-bubble-in");
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = who;
    const body = document.createElement("div");
    body.textContent = text;
    bubble.appendChild(meta);
    bubble.appendChild(body);
    row.appendChild(bubble);
    els.messages.appendChild(row);
    els.messages.scrollTop = els.messages.scrollHeight;
    if (roomIdActive) {
      upsertRecent({ id: roomIdActive, title: els.chatPeerTitle ? els.chatPeerTitle.textContent : roomIdActive, lastText: text, ts: Date.now() });
    }
  }

  function sendRaw(obj) {
    if (dataConn && dataConn.open) {
      dataConn.send(JSON.stringify(obj));
    }
  }

  async function beginHandshake() {
    cryptoState.keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const pubJwk = await crypto.subtle.exportKey("jwk", cryptoState.keyPair.publicKey);
    sendRaw({ t: "hs", name: displayName || "Гость", pub: pubJwk });

    if (pendingPeerHs) {
      await applyPeerHandshake(pendingPeerHs);
      pendingPeerHs = null;
    }
  }

  async function applyPeerHandshake(msg) {
    if (cryptoState.ready) return;
    if (msg && msg.name) {
      peerDisplayName = msg.name;
      if (els.chatPeerTitle) els.chatPeerTitle.textContent = peerDisplayName;
      if (roomIdActive) upsertRecent({ id: roomIdActive, title: peerDisplayName, ts: Date.now() });
    }
    cryptoState.peerPublic = await crypto.subtle.importKey("jwk", msg.pub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    if (!cryptoState.keyPair) return;

    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: cryptoState.peerPublic },
      cryptoState.keyPair.privateKey,
      256
    );
    cryptoState.aesKey = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    cryptoState.ready = true;
    addSystemLine(
      lang === "en"
        ? "End-to-end encryption active. Keys exist only in this tab."
        : "Сквозное шифрование включено. Ключи только в этой вкладке."
    );
    els.inputMessage.disabled = false;
    els.btnSend.disabled = false;
    updateCallButtonState();
  }

  async function onChannelData(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === "hs") {
      if (msg.name) {
        peerDisplayName = msg.name;
        if (els.chatPeerTitle) els.chatPeerTitle.textContent = peerDisplayName;
        if (roomIdActive) upsertRecent({ id: roomIdActive, title: peerDisplayName, ts: Date.now() });
      }
      if (!cryptoState.keyPair) {
        pendingPeerHs = msg;
        return;
      }
      await applyPeerHandshake(msg);
      return;
    }
    if (msg.t === "m" && cryptoState.ready && cryptoState.aesKey) {
      try {
        const iv = ub64(msg.iv);
        const data = ub64(msg.d);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoState.aesKey, data);
        const text = new TextDecoder().decode(plain);
        addChatLine(peerDisplayName || t("peerFallback"), text, false);
      } catch (e) {
        console.error("Decrypt failed", e);
        addSystemLine(lang === "en" ? "Could not decrypt message." : "Не удалось расшифровать сообщение.");
      }
    }
  }

  function armGuestDataTimeout(conn, rid) {
    clearGuestRetry();
    guestRetryTimer = setTimeout(() => {
      guestRetryTimer = null;
      if (conn.open) return;
      try {
        conn.close();
      } catch (_) {}
      if (dataConn === conn) dataConn = null;
      scheduleGuestReconnect(
        rid,
        lang === "en"
          ? "Host not responding. They must open the room first and keep this tab open."
          : "Нет ответа от создателя. Он должен первым открыть комнату и не закрывать вкладку."
      );
    }, 14000);
  }

  function scheduleGuestReconnect(rid, hint) {
    if (isHost || !rid || !peer || !peer.open) return;
    if (dataConn && dataConn.open) return;

    guestConnectFailures++;
    if (guestConnectFailures > GUEST_FAIL_MAX) {
      setConnStatus("err", "—");
      addSystemLine(
        lang === "en"
          ? "Could not reach host. Free PeerJS is unstable — both try again: host creates a new room, guest opens the new link."
          : "Не удалось связаться. Бесплатный PeerJS нестабилен: хост создаёт комнату заново, гость открывает новую ссылку."
      );
      return;
    }

    if (hint) addSystemLine(hint);

    const delay = Math.min(1800 + guestConnectFailures * 220, 9000);
    setConnStatus("wait", `${guestConnectFailures}/${GUEST_FAIL_MAX}`);

    clearGuestRetry();
    guestRetryTimer = setTimeout(() => {
      guestRetryTimer = null;
      tryGuestDataConnect(rid);
    }, delay);
  }

  function tryGuestDataConnect(rid) {
    if (!peer || !peer.open || isHost) return;
    if (dataConn && dataConn.open) return;

    if (dataConn) {
      try {
        dataConn.close();
      } catch (_) {}
      dataConn = null;
    }

    const conn = peer.connect(rid, { reliable: true });
    setupDataConnection(conn);
    armGuestDataTimeout(conn, rid);
  }

  function setupDataConnection(conn) {
    dataConn = conn;

    conn.on("open", () => {
      clearGuestRetry();
      guestConnectFailures = 0;
      console.log("DrazzeAnonim: DataChannel open");
      setConnStatus("ok", "●");
      beginHandshake().catch((e) => console.error(e));
    });

    conn.on("data", onChannelData);
    conn.on("close", () => {
      addSystemLine(lang === "en" ? "Chat closed." : "Чат закрыт.");
      setConnStatus("err", "—");
      els.inputMessage.disabled = true;
      els.btnSend.disabled = true;
    });
    conn.on("error", (e) => {
      if (!isHost && roomIdActive && dataConn === conn && !conn.open) {
        clearGuestRetry();
        try {
          conn.close();
        } catch (_) {}
        dataConn = null;
        scheduleGuestReconnect(roomIdActive, lang === "en" ? "Retrying…" : "Повтор подключения…");
      } else {
        console.error("DataConnection error", e);
      }
    });
  }

  function wireMediaCall(call) {
    mediaCall = call;
    call.on("stream", (remote) => {
      els.videoRemote.srcObject = remote;
    });
    call.on("close", () => {
      cleanupCall();
      if (notifyAllowed("call")) addSystemLine(lang === "en" ? "Call ended." : "Звонок завершён.");
    });
    call.on("error", (e) => console.error("MediaConnection error", e));
  }

  async function getOrCreateLocalStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    els.videoLocal.srcObject = localStream;
    showCallDock();
    return localStream;
  }

  function onIncomingCall(call) {
    showCallDock();
    getOrCreateLocalStream()
      .then((stream) => {
        call.answer(stream);
        wireMediaCall(call);
        els.btnCall.classList.add("hidden");
        els.btnHangup.classList.remove("hidden");
        if (notifyAllowed("call")) addSystemLine(lang === "en" ? "Incoming call answered." : "Входящий звонок принят.");
      })
      .catch((e) => {
        console.error(e);
        if (notifyAllowed("call"))
          addSystemLine(lang === "en" ? "Camera/mic permission denied." : "Нет доступа к камере/микрофону.");
        hideCallDock();
      });
  }

  function updateCallButtonState() {
    const can =
      peer && peer.open && (isHost ? dataConn && dataConn.open && !!callTargetId : !!callTargetId);
    els.btnCall.disabled = !can;
  }

  async function startOutgoingCall() {
    if (!peer || !callTargetId) return;
    showCallDock();
    try {
      const stream = await getOrCreateLocalStream();
      const call = peer.call(callTargetId, stream);
      wireMediaCall(call);
      els.btnCall.classList.add("hidden");
      els.btnHangup.classList.remove("hidden");
      if (notifyAllowed("call")) addSystemLine(lang === "en" ? "Calling…" : "Звонок…");
    } catch (e) {
      console.error(e);
      hideCallDock();
      if (notifyAllowed("call"))
        addSystemLine(lang === "en" ? "Could not start call." : "Не удалось начать звонок.");
    }
  }

  function copyInviteLink() {
    if (!roomIdActive) return;
    const url = `${window.location.origin}${window.location.pathname}#${roomIdActive}`;
    navigator.clipboard.writeText(url).then(
      () => addSystemLine(t("inviteCopied")),
      () => addSystemLine(t("inviteManual") + url)
    );
  }

  function isRecoverableGuestError(err) {
    const msg = (err && err.message) || String(err || "");
    const type = err && err.type;
    if (type === "peer-unavailable" || type === "network") return true;
    return /could not connect|peer-unavailable|unavailable|socket|network|connection/i.test(msg);
  }

  function bindPeerCommon(p) {
    p.on("error", (err) => {
      const msg = err.message || String(err);

      if (!isHost && roomIdActive && isRecoverableGuestError(err)) {
        if (typeof console !== "undefined" && console.debug) {
          console.debug("DrazzeAnonim: recoverable peer error (retrying)", msg);
        }
        if (dataConn && !dataConn.open) {
          try {
            dataConn.close();
          } catch (_) {}
          dataConn = null;
        }
        clearGuestRetry();
        scheduleGuestReconnect(
          roomIdActive,
          lang === "en"
            ? "Signaling could not find the host yet — retrying. Host tab must stay open."
            : "Сигналинг пока не видит хоста — повтор. Вкладка создателя должна быть открыта."
        );
        return;
      }

      if (notifyAllowed("chat")) addSystemLine("PeerJS: " + msg);
      setConnStatus("err", "!");
      if (typeof console !== "undefined" && console.warn) console.warn("Peer error", err);
    });

    p.on("disconnected", () => {
      if (notifyAllowed("chat")) addSystemLine(lang === "en" ? "Signaling disconnected." : "Сигналинг отключён.");
      setConnStatus("wait", "…");
      if (isHost && peer) {
        try {
          peer.reconnect();
        } catch (e) {
          console.error(e);
        }
      } else {
        setConnStatus("err", "—");
        if (notifyAllowed("chat"))
          addSystemLine(lang === "en" ? "Reload and open the link again." : "Обновите страницу и откройте ссылку снова.");
      }
    });

    p.on("call", onIncomingCall);
  }

  function createRoom() {
    showLobbyError("");
    displayName = (els.inputName && els.inputName.value.trim()) || (els.profileNick && els.profileNick.value.trim()) || "";
    const id = makeRoomId();
    isHost = true;
    roomIdActive = id;
    callTargetId = null;
    resetCrypto();
    showRoomScreen(id);
    upsertRecent({ id, title: lang === "en" ? "Room " + shortRoom(id) : "Комната " + shortRoom(id), ts: Date.now() });
    if (els.chatPeerTitle) els.chatPeerTitle.textContent = t("peerFallback");

    els.roomHint.hidden = false;
    els.roomHint.textContent =
      lang === "en"
        ? "Share the link. Your friend opens it while this tab stays open."
        : "Отправьте ссылку. Друг открывает её, пока эта вкладка открыта.";

    peer = new Peer(id, PEER_OPTIONS);
    bindPeerCommon(peer);

    peer.on("open", () => {
      addSystemLine(lang === "en" ? "Room is live. You can share the link." : "Комната активна. Можно отправить ссылку.");
      updateCallButtonState();
    });

    peer.on("connection", (conn) => {
      callTargetId = conn.peer;
      setupDataConnection(conn);
      updateCallButtonState();
    });
  }

  function joinRoom(remoteId) {
    showLobbyError("");
    displayName = (els.inputName && els.inputName.value.trim()) || (els.profileNick && els.profileNick.value.trim()) || "";
    const rid = (remoteId || els.inputRoom.value).trim();
    if (!rid) {
      showLobbyError(lang === "en" ? "Enter room ID." : "Укажите ID комнаты.");
      return;
    }
    isHost = false;
    roomIdActive = rid;
    callTargetId = rid;
    resetCrypto();
    showRoomScreen(rid);
    upsertRecent({ id: rid, title: lang === "en" ? "Chat " + shortRoom(rid) : "Чат " + shortRoom(rid), ts: Date.now() });

    els.roomHint.hidden = false;
    els.roomHint.textContent =
      lang === "en"
        ? "Waiting for host. We retry automatically."
        : "Ждём создателя комнаты. Повторяем подключение автоматически.";

    peer = new Peer(PEER_OPTIONS);
    bindPeerCommon(peer);

    peer.on("open", () => {
      guestConnectFailures = 0;
      tryGuestDataConnect(rid);
      updateCallButtonState();
    });
  }

  function sendChatMessage(text) {
    if (!dataConn || !dataConn.open || !cryptoState.ready || !cryptoState.aesKey) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    crypto.subtle
      .encrypt({ name: "AES-GCM", iv }, cryptoState.aesKey, new TextEncoder().encode(text))
      .then((ct) => {
        sendRaw({ t: "m", iv: b64(iv), d: b64(new Uint8Array(ct)) });
        addChatLine(displayName || (lang === "en" ? "You" : "Вы"), text, true);
      })
      .catch((e) => console.error(e));
  }

  document.querySelectorAll(".nav-item[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.getAttribute("data-nav")));
  });

  document.querySelectorAll(".calls-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".calls-filter").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });

  if (els.btnToggleNew && els.newChatDrawer) {
    els.btnToggleNew.addEventListener("click", () => {
      const open = els.newChatDrawer.classList.toggle("hidden");
      els.btnToggleNew.setAttribute("aria-expanded", String(!open));
    });
  }

  if (els.chatListSearch) els.chatListSearch.addEventListener("input", renderChatList);
  if (els.contactsSearch) els.contactsSearch.addEventListener("input", renderContacts);

  if (els.btnSaveProfile) {
    els.btnSaveProfile.addEventListener("click", () => {
      saveProfile();
      const ok = document.createElement("p");
      ok.className = "tg-hint-list";
      ok.style.marginTop = "0.5rem";
      ok.textContent = lang === "en" ? "Saved on this device." : "Сохранено на этом устройстве.";
      els.btnSaveProfile.insertAdjacentElement("afterend", ok);
      setTimeout(() => ok.remove(), 2200);
    });
  }

  if (els.btnInviteRef) {
    els.btnInviteRef.addEventListener("click", () => {
      const url = window.location.origin + window.location.pathname;
      const text = t("appInvite") + url;
      navigator.clipboard.writeText(text).then(
        () => {
          const note = document.createElement("div");
          note.className = "tg-hint-list";
          note.textContent = t("inviteCopied");
          els.contactsList.parentNode.insertBefore(note, els.contactsList);
          setTimeout(() => note.remove(), 2500);
        },
        () => alert(text)
      );
    });
  }

  if (els.setLang) {
    els.setLang.addEventListener("change", () => {
      lang = els.setLang.value === "en" ? "en" : "ru";
      saveSettings();
      applyLangToNav();
      renderChatList();
    });
  }

  [els.setNotifyChat, els.setNotifyCall].forEach((el) => {
    if (el) el.addEventListener("change", saveSettings);
  });

  if (els.profileNick) els.profileNick.addEventListener("input", updateProfileAvatar);

  els.btnCreate.addEventListener("click", () => createRoom());
  els.btnJoin.addEventListener("click", () => joinRoom(null));
  els.btnBack.addEventListener("click", () => leaveRoom());
  els.btnCopy.addEventListener("click", () => copyInviteLink());
  els.btnCall.addEventListener("click", () => startOutgoingCall());
  els.btnHangup.addEventListener("click", () => {
    cleanupCall();
    if (notifyAllowed("call")) addSystemLine(lang === "en" ? "You ended the call." : "Вы завершили звонок.");
  });

  els.formSend.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const txt = els.inputMessage.value.trim();
    if (!txt) return;
    sendChatMessage(txt);
    els.inputMessage.value = "";
  });

  window.addEventListener("beforeunload", () => {
    if (peer) peer.destroy();
  });

  function bootFromHash() {
    const fromHash = parseRoomFromHash();
    if (fromHash) {
      setInviteMode(fromHash);
      joinRoom(fromHash);
    }
  }

  loadSettings();
  loadProfile();
  applyLangToNav();
  renderChatList();
  renderContacts();

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", bootFromHash);
  } else {
    bootFromHash();
  }
})();
