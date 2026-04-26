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

  let guestConnectFailures = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let guestRetryTimer = null;

  const cryptoState = {
    /** @type {CryptoKeyPair | null} */
    keyPair: null,
    /** @type {CryptoKey | null} */
    peerPublic: null,
    /** @type {CryptoKey | null} */
    aesKey: null,
    ready: false,
  };
  /** @type {object | null} */
  let pendingPeerHs = null;

  const els = {
    screenLobby: document.getElementById("screen-lobby"),
    screenRoom: document.getElementById("screen-room"),
    inputName: document.getElementById("input-name"),
    inputRoom: document.getElementById("input-room"),
    inputMessage: document.getElementById("input-message"),
    btnCreate: document.getElementById("btn-create"),
    btnJoin: document.getElementById("btn-join"),
    btnCopy: document.getElementById("btn-copy-link"),
    btnCall: document.getElementById("btn-call"),
    btnHangup: document.getElementById("btn-hangup"),
    btnLeave: document.getElementById("btn-leave"),
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
    divider: document.querySelector(".divider"),
  };

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
    if (els.divider) els.divider.style.display = "none";
  }

  function clearGuestRetry() {
    if (guestRetryTimer) {
      clearTimeout(guestRetryTimer);
      guestRetryTimer = null;
    }
  }

  function showRoomScreen(id) {
    els.screenLobby.classList.add("hidden");
    els.screenRoom.classList.remove("hidden");
    els.roomIdDisplay.textContent = id;
    setConnStatus("wait", "Подключение…");
    els.messages.innerHTML = "";
    els.inputMessage.value = "";
    els.inputMessage.disabled = true;
    els.btnSend.disabled = true;
    guestConnectFailures = 0;
    clearGuestRetry();
  }

  function showLobbyScreen() {
    els.screenRoom.classList.add("hidden");
    els.screenLobby.classList.remove("hidden");
    els.inputRoom.readOnly = false;
    els.btnCreate.hidden = false;
    if (els.divider) els.divider.style.display = "";
    els.connStatus.className = "status status-wait";
    els.roomHint.hidden = true;
    resetVideosUi();
  }

  function setConnStatus(kind, text) {
    els.connStatus.textContent = text;
    els.connStatus.className = "status " + (kind === "ok" ? "status-ok" : kind === "err" ? "status-err" : "status-wait");
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
  }

  function addSystemLine(text) {
    const div = document.createElement("div");
    div.className = "msg msg-system";
    div.textContent = text;
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addChatLine(who, text) {
    const div = document.createElement("div");
    div.className = "msg";
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = who;
    const body = document.createElement("div");
    body.textContent = text;
    div.appendChild(meta);
    div.appendChild(body);
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
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
    cryptoState.peerPublic = await crypto.subtle.importKey("jwk", msg.pub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    if (!cryptoState.keyPair) return;

    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: cryptoState.peerPublic },
      cryptoState.keyPair.privateKey,
      256
    );
    cryptoState.aesKey = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    cryptoState.ready = true;
    addSystemLine("Канал зашифрован (AES-GCM, эфемерный ECDH). История только в этой вкладке.");
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
        addChatLine("Собеседник", text);
      } catch (e) {
        console.error("Decrypt failed", e);
        addSystemLine("Не удалось расшифровать сообщение.");
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
        "Нет ответа от создателя комнаты. Он должен первым открыть страницу и нажать «Создать комнату», затем отправить вам ссылку."
      );
    }, 14000);
  }

  function scheduleGuestReconnect(rid, hint) {
    if (isHost || !rid || !peer || !peer.open) return;
    if (dataConn && dataConn.open) return;

    guestConnectFailures++;
    if (guestConnectFailures > GUEST_FAIL_MAX) {
      setConnStatus("err", "Хост не найден");
      addSystemLine(
        "Частая причина — бесплатный сервер PeerJS (0.peerjs.com) или создатель закрыл вкладку до вашего входа. Пусть хост снова нажмёт «Создать комнату», вы откройте новую ссылку сразу после этого."
      );
      return;
    }

    if (hint) addSystemLine(hint);

    const delay = Math.min(1800 + guestConnectFailures * 220, 9000);
    setConnStatus("wait", `Ищем собеседника… ${guestConnectFailures}/${GUEST_FAIL_MAX}`);

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
      console.log("DrazzeAnonim: DataChannel открыт — P2P готов.");
      setConnStatus("ok", "В чате");
      beginHandshake().catch((e) => console.error(e));
    });

    conn.on("data", onChannelData);
    conn.on("close", () => {
      addSystemLine("Собеседник отключился или канал закрыт.");
      setConnStatus("err", "Отключено");
      els.inputMessage.disabled = true;
      els.btnSend.disabled = true;
    });
    conn.on("error", (e) => {
      console.error("DataConnection error", e);
      if (!isHost && roomIdActive && dataConn === conn && !conn.open) {
        clearGuestRetry();
        try {
          conn.close();
        } catch (_) {}
        dataConn = null;
        scheduleGuestReconnect(roomIdActive, "Ошибка канала данных, пробуем снова…");
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
      addSystemLine("Звонок завершён.");
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
        addSystemLine("Входящий звонок — микрофон и камера подключены.");
      })
      .catch((e) => {
        console.error(e);
        addSystemLine("Нет доступа к камере/микрофону. Разрешите доступ в браузере.");
        hideCallDock();
      });
  }

  function updateCallButtonState() {
    const can =
      peer &&
      peer.open &&
      (isHost ? dataConn && dataConn.open && !!callTargetId : !!callTargetId);
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
      addSystemLine("Звонок… ждём ответа собеседника.");
    } catch (e) {
      console.error(e);
      hideCallDock();
      addSystemLine("Не удалось получить камеру/микрофон или начать звонок. Проверьте разрешения браузера.");
    }
  }

  function copyInviteLink() {
    if (!roomIdActive) return;
    const url = `${window.location.origin}${window.location.pathname}#${roomIdActive}`;
    navigator.clipboard.writeText(url).then(
      () => addSystemLine("Ссылка скопирована."),
      () => addSystemLine("Скопируйте вручную: " + url)
    );
  }

  function bindPeerCommon(p) {
    p.on("error", (err) => {
      const msg = err.message || String(err);
      console.error("Peer error", err);

      if (!isHost && roomIdActive && /could not connect/i.test(msg)) {
        if (dataConn && !dataConn.open) {
          try {
            dataConn.close();
          } catch (_) {}
          dataConn = null;
        }
        clearGuestRetry();
        scheduleGuestReconnect(
          roomIdActive,
          "Сервер сигнализации не видит создателя комнаты (часто на 0.peerjs.com). Повторяем. Убедитесь, что у друга открыта вкладка с комнатой."
        );
        return;
      }

      addSystemLine("PeerJS: " + msg);
      setConnStatus("err", "Ошибка сети");
    });

    p.on("disconnected", () => {
      addSystemLine("Связь с сигнальным сервером прервалась.");
      setConnStatus("wait", "Сигналинг…");
      if (isHost && peer) {
        try {
          peer.reconnect();
          addSystemLine("Переподключение хоста к PeerServer…");
        } catch (e) {
          console.error(e);
        }
      } else {
        setConnStatus("err", "Обновите страницу");
        addSystemLine("Гостю нужно обновить страницу и снова открыть ссылку.");
      }
    });

    p.on("call", onIncomingCall);
  }

  function createRoom() {
    showLobbyError("");
    displayName = els.inputName.value.trim();
    const id = makeRoomId();
    isHost = true;
    roomIdActive = id;
    callTargetId = null;
    resetCrypto();
    showRoomScreen(id);

    els.roomHint.hidden = false;
    els.roomHint.textContent =
      "Отправьте ссылку другу. Пусть он откроет её, когда эта вкладка уже открыта — иначе «Could not connect to peer».";

    peer = new Peer(id, PEER_OPTIONS);
    bindPeerCommon(peer);

    peer.on("open", (openedId) => {
      console.log("DrazzeAnonim: хост зарегистрирован как", openedId);
      addSystemLine("Комната активна. Можно отправлять ссылку.");
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
    displayName = els.inputName.value.trim();
    const rid = (remoteId || els.inputRoom.value).trim();
    if (!rid) {
      showLobbyError("Укажите ID комнаты.");
      return;
    }
    isHost = false;
    roomIdActive = rid;
    callTargetId = rid;
    resetCrypto();
    showRoomScreen(rid);

    els.roomHint.hidden = false;
    els.roomHint.textContent =
      "Сначала друг должен создать комнату и оставить страницу открытой. Мы будем повторять подключение автоматически.";

    peer = new Peer(PEER_OPTIONS);
    bindPeerCommon(peer);

    peer.on("open", () => {
      console.log("DrazzeAnonim: клиент на сигналинге, подключаемся к", rid);
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
        addChatLine(displayName || "Вы", text);
      })
      .catch((e) => console.error(e));
  }

  els.btnCreate.addEventListener("click", () => createRoom());
  els.btnJoin.addEventListener("click", () => joinRoom(null));
  els.btnLeave.addEventListener("click", () => leaveRoom());
  els.btnCopy.addEventListener("click", () => copyInviteLink());
  els.btnCall.addEventListener("click", () => startOutgoingCall());
  els.btnHangup.addEventListener("click", () => {
    cleanupCall();
    addSystemLine("Вы завершили звонок.");
  });

  els.formSend.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const t = els.inputMessage.value.trim();
    if (!t) return;
    sendChatMessage(t);
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

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", bootFromHash);
  } else {
    bootFromHash();
  }
})();
