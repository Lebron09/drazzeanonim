(function () {
  "use strict";

  const PEER_OPTIONS = {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
    debug: 0,
  };

  let peer = null;
  let dataConn = null;
  let mediaCall = null;
  let localStream = null;
  let roomId = null;
  let targetPeerId = null;
  let isHost = false;

  const cryptoState = {
    keyPair: null,
    remotePub: null,
    aesKey: null,
    ready: false,
  };
  let pendingHandshake = null;

  const els = {
    lobby: document.getElementById("lobby"),
    chat: document.getElementById("chat"),
    inputName: document.getElementById("input-name"),
    inputRoom: document.getElementById("input-room"),
    inputMessage: document.getElementById("input-message"),
    sendForm: document.getElementById("send-form"),
    btnSend: document.getElementById("btn-send"),
    btnCreate: document.getElementById("btn-create"),
    btnJoin: document.getElementById("btn-join"),
    btnLeave: document.getElementById("btn-leave"),
    btnRetry: document.getElementById("btn-retry"),
    btnCopy: document.getElementById("btn-copy"),
    btnCall: document.getElementById("btn-call"),
    btnHangup: document.getElementById("btn-hangup"),
    lobbyError: document.getElementById("lobby-error"),
    roomId: document.getElementById("room-id"),
    status: document.getElementById("status"),
    roomNote: document.getElementById("room-note"),
    messages: document.getElementById("messages"),
    videos: document.getElementById("videos"),
    videoLocal: document.getElementById("video-local"),
    videoRemote: document.getElementById("video-remote"),
  };

  function randomRoomId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return `dra${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  function fromHash() {
    return location.hash.replace(/^#/, "").trim();
  }

  function showLobbyError(text) {
    els.lobbyError.hidden = !text;
    els.lobbyError.textContent = text || "";
  }

  function setStatus(kind, text) {
    els.status.className = `status ${kind}`;
    els.status.textContent = text;
  }

  function addSystem(text) {
    const div = document.createElement("div");
    div.className = "sys";
    div.textContent = text;
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addMessage(author, text, mine) {
    const row = document.createElement("div");
    row.className = `msg${mine ? " mine" : ""}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = author;
    const body = document.createElement("div");
    body.textContent = text;
    bubble.appendChild(meta);
    bubble.appendChild(body);
    row.appendChild(bubble);
    els.messages.appendChild(row);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function updateControlsConnected(connected) {
    els.inputMessage.disabled = !connected;
    els.btnSend.disabled = !connected;
    els.btnCall.disabled = !connected || !targetPeerId;
    els.btnRetry.classList.toggle("hidden", connected || isHost);
  }

  function resetCrypto() {
    cryptoState.keyPair = null;
    cryptoState.remotePub = null;
    cryptoState.aesKey = null;
    cryptoState.ready = false;
    pendingHandshake = null;
  }

  function closeCallUi() {
    if (mediaCall) {
      try { mediaCall.close(); } catch (_) {}
      mediaCall = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    els.videoLocal.srcObject = null;
    els.videoRemote.srcObject = null;
    els.videos.classList.add("hidden");
    els.btnCall.classList.remove("hidden");
    els.btnHangup.classList.add("hidden");
  }

  function destroyPeer() {
    if (dataConn) {
      try { dataConn.close(); } catch (_) {}
      dataConn = null;
    }
    if (peer) {
      try { peer.destroy(); } catch (_) {}
      peer = null;
    }
  }

  function leaveRoom() {
    closeCallUi();
    destroyPeer();
    resetCrypto();
    roomId = null;
    targetPeerId = null;
    isHost = false;
    els.messages.innerHTML = "";
    els.inputMessage.value = "";
    updateControlsConnected(false);
    els.chat.classList.add("hidden");
    els.lobby.classList.remove("hidden");
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }

  function toBase64(u8) {
    let s = "";
    u8.forEach((v) => { s += String.fromCharCode(v); });
    return btoa(s);
  }

  function fromBase64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function startHandshake() {
    cryptoState.keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const pub = await crypto.subtle.exportKey("jwk", cryptoState.keyPair.publicKey);
    sendRaw({ t: "hs", n: getMyName(), p: pub });

    if (pendingHandshake) {
      await applyHandshake(pendingHandshake);
      pendingHandshake = null;
    }
  }

  async function applyHandshake(msg) {
    if (cryptoState.ready) return;
    cryptoState.remotePub = await crypto.subtle.importKey(
      "jwk",
      msg.p,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    if (!cryptoState.keyPair) return;

    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: cryptoState.remotePub },
      cryptoState.keyPair.privateKey,
      256
    );
    cryptoState.aesKey = await crypto.subtle.importKey(
      "raw",
      bits,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    cryptoState.ready = true;
    addSystem("Шифрование активно. Можно писать сообщения.");
    setStatus("ok", "Онлайн");
    updateControlsConnected(true);
  }

  async function onData(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === "hs") {
      if (msg.n) addSystem(`Подключился: ${msg.n}`);
      if (!cryptoState.keyPair) {
        pendingHandshake = msg;
        return;
      }
      await applyHandshake(msg);
      return;
    }

    if (msg.t === "m" && cryptoState.ready && cryptoState.aesKey) {
      try {
        const iv = fromBase64(msg.iv);
        const data = fromBase64(msg.d);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoState.aesKey, data);
        addMessage("Собеседник", new TextDecoder().decode(plain), false);
      } catch (_) {
        addSystem("Не удалось расшифровать сообщение.");
      }
    }
  }

  function sendRaw(obj) {
    if (dataConn && dataConn.open) dataConn.send(JSON.stringify(obj));
  }

  async function sendEncrypted(text) {
    if (!cryptoState.ready || !cryptoState.aesKey) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoState.aesKey,
      new TextEncoder().encode(text)
    );
    sendRaw({ t: "m", iv: toBase64(iv), d: toBase64(new Uint8Array(enc)) });
    addMessage(getMyName(), text, true);
  }

  function wireConnection(conn) {
    dataConn = conn;
    setStatus("wait", "Соединяемся");
    updateControlsConnected(false);
    els.btnRetry.classList.toggle("hidden", isHost);

    conn.on("open", () => {
      setStatus("wait", "Канал открыт");
      targetPeerId = conn.peer;
      els.btnRetry.classList.add("hidden");
      startHandshake().catch(() => addSystem("Ошибка handshake."));
    });

    conn.on("data", onData);

    conn.on("close", () => {
      setStatus("err", "Отключено");
      addSystem("Соединение закрыто.");
      updateControlsConnected(false);
      if (!isHost) els.btnRetry.classList.remove("hidden");
    });

    conn.on("error", (e) => {
      setStatus("err", "Ошибка канала");
      addSystem(`Ошибка: ${e.type || e.message || "data channel"}`);
      updateControlsConnected(false);
      if (!isHost) els.btnRetry.classList.remove("hidden");
    });
  }

  async function getMedia() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    els.videoLocal.srcObject = localStream;
    els.videos.classList.remove("hidden");
    return localStream;
  }

  function wireCall(call) {
    mediaCall = call;
    call.on("stream", (remote) => {
      els.videoRemote.srcObject = remote;
      els.videos.classList.remove("hidden");
    });
    call.on("close", () => {
      closeCallUi();
      addSystem("Звонок завершен.");
    });
    call.on("error", () => {
      addSystem("Ошибка звонка.");
    });
  }

  function bindPeerEvents() {
    peer.on("error", (err) => {
      const msg = err && (err.message || err.type) ? (err.message || err.type) : "PeerJS error";
      setStatus("err", "Ошибка сети");
      addSystem(msg);
      if (!isHost) els.btnRetry.classList.remove("hidden");
    });

    peer.on("disconnected", () => {
      setStatus("err", "Сигналинг отключен");
      addSystem("Сигнальный сервер отключился. Нажмите Повторить.");
      if (!isHost) els.btnRetry.classList.remove("hidden");
    });

    peer.on("call", (call) => {
      getMedia().then((stream) => {
        call.answer(stream);
        wireCall(call);
        els.btnCall.classList.add("hidden");
        els.btnHangup.classList.remove("hidden");
      }).catch(() => addSystem("Нет доступа к камере/микрофону."));
    });

    if (isHost) {
      peer.on("connection", (conn) => {
        targetPeerId = conn.peer;
        wireConnection(conn);
      });
    }
  }

  function openRoomUi(id) {
    els.lobby.classList.add("hidden");
    els.chat.classList.remove("hidden");
    els.roomId.textContent = id;
    els.messages.innerHTML = "";
    setStatus("wait", "Ожидание");
    updateControlsConnected(false);
    els.roomNote.textContent = isHost
      ? "Отправьте другу ссылку и не закрывайте вкладку."
      : "Подключение к комнате. Если не вышло — нажмите Повторить.";
  }

  function getMyName() {
    return (els.inputName.value || "").trim() || "Гость";
  }

  function createRoom() {
    showLobbyError("");
    leaveRoom();
    isHost = true;
    roomId = randomRoomId();
    targetPeerId = null;
    resetCrypto();
    openRoomUi(roomId);
    location.hash = roomId;

    peer = new Peer(roomId, PEER_OPTIONS);
    bindPeerEvents();

    peer.on("open", () => {
      setStatus("wait", "Ждем собеседника");
      addSystem("Комната создана. Скопируйте ссылку и отправьте другу.");
    });
  }

  function joinRoom(idFromInput) {
    showLobbyError("");
    const id = (idFromInput || els.inputRoom.value || "").trim();
    if (!id) {
      showLobbyError("Введите ID комнаты.");
      return;
    }

    leaveRoom();
    isHost = false;
    roomId = id;
    targetPeerId = id;
    resetCrypto();
    openRoomUi(id);
    location.hash = id;
    els.btnRetry.classList.remove("hidden");

    peer = new Peer(PEER_OPTIONS);
    bindPeerEvents();

    peer.on("open", () => {
      connectToHost();
    });
  }

  function connectToHost() {
    if (!peer || !roomId || isHost) return;
    setStatus("wait", "Подключаемся");
    addSystem("Попытка подключения к комнате...");
    try {
      const conn = peer.connect(roomId, { reliable: true });
      wireConnection(conn);
    } catch (_) {
      setStatus("err", "Не удалось");
      addSystem("Не удалось открыть data channel.");
      els.btnRetry.classList.remove("hidden");
    }
  }

  function copyInvite() {
    if (!roomId) return;
    const url = `${location.origin}${location.pathname}#${roomId}`;
    navigator.clipboard.writeText(url).then(
      () => addSystem("Ссылка скопирована."),
      () => addSystem(`Скопируйте вручную: ${url}`)
    );
  }

  els.btnCreate.addEventListener("click", createRoom);
  els.btnJoin.addEventListener("click", () => joinRoom(null));
  els.btnLeave.addEventListener("click", leaveRoom);
  els.btnRetry.addEventListener("click", connectToHost);
  els.btnCopy.addEventListener("click", copyInvite);

  els.sendForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = els.inputMessage.value.trim();
    if (!text) return;
    await sendEncrypted(text);
    els.inputMessage.value = "";
  });

  els.btnCall.addEventListener("click", async () => {
    if (!peer || !targetPeerId) return;
    try {
      const stream = await getMedia();
      const call = peer.call(targetPeerId, stream);
      wireCall(call);
      els.btnCall.classList.add("hidden");
      els.btnHangup.classList.remove("hidden");
      addSystem("Исходящий звонок...");
    } catch (_) {
      addSystem("Не удалось начать звонок. Проверьте доступ к камере/микрофону.");
    }
  });

  els.btnHangup.addEventListener("click", () => {
    closeCallUi();
  });

  window.addEventListener("beforeunload", () => {
    if (peer) peer.destroy();
  });

  const hashed = fromHash();
  if (hashed) {
    els.inputRoom.value = hashed;
    joinRoom(hashed);
  }
})();
