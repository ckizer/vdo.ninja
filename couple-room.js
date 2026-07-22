(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  if (!params.has("coupleroom")) return;

  var PROTOCOL_VERSION = 1;
  var ADAPTER_VERSION = "1.1.0";
  var PREFIX = "__COUPLE_ROOM_EVENT__:";
  var nonce = params.get("coupleroomnonce") || "";
  var opaqueParent = params.get("coupleroomopaque") === "1";
  var expectedParentOrigin = decodeURIComponent(params.get("iframetarget") || "");
  var targetOrigin = opaqueParent ? "*" : expectedParentOrigin;
  var revision = 0;
  var framePending = false;
  var hangupSent = false;
  var lastStateSignature = "";
  var originalGetChatMessage = window.getChatMessage;
  var originalUpdateUserList = window.updateUserList;
  var tileIds = new WeakMap();
  var tileIdSequence = 0;
  var hoveredTileId = null;
  var spaceDragPressed = false;
  var localAudioMuted = false;

  document.documentElement.classList.add("couple-room");

  function reportHoveredTile(tileId) {
    if (hoveredTileId === tileId) return;
    hoveredTileId = tileId;
    post("tile.hover", { tileId: tileId });
  }

  function setSpaceDragCursor(pressed) {
    document.documentElement.classList.toggle("couple-room-space-drag", pressed);
  }

  function reportSpaceDrag(pressed) {
    setSpaceDragCursor(pressed);
    if (spaceDragPressed === pressed) return;
    spaceDragPressed = pressed;
    post("tile.space", { pressed: pressed });
  }

  document.addEventListener("pointermove", function (event) {
    var target = event.target;
    var container = target && typeof target.closest === "function"
      ? target.closest(".container_holder_video")
      : null;
    reportHoveredTile(container && container.dataset.coupleRoomTileId || null);
  }, { passive: true });
  document.addEventListener("pointerleave", function () {
    reportHoveredTile(null);
  });
  document.addEventListener("keydown", function (event) {
    if (event.code !== "Space") return;
    var target = event.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    reportSpaceDrag(true);
  }, true);
  document.addEventListener("keyup", function (event) {
    if (event.code !== "Space") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    reportSpaceDrag(false);
  }, true);
  window.addEventListener("blur", function () {
    reportHoveredTile(null);
  });

  function id() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function envelope(type, payload, replyTo) {
    return {
      source: "couple-room-vdo",
      protocolVersion: PROTOCOL_VERSION,
      type: type,
      id: id(),
      replyTo: replyTo,
      sentAt: Date.now(),
      nonce: nonce,
      payload: payload
    };
  }

  function post(type, payload, replyTo) {
    if (window.parent === window || !targetOrigin) return;
    try {
      window.parent.postMessage(envelope(type, payload, replyTo), targetOrigin);
    } catch (error) {
      if (opaqueParent) window.parent.postMessage(envelope(type, payload, replyTo), "*");
    }
  }

  function isTrustedParent(event) {
    if (event.source !== window.parent || !nonce) return false;
    if (opaqueParent) return true;
    return Boolean(expectedParentOrigin) && event.origin === expectedParentOrigin;
  }

  function isEnvelope(value) {
    return value
      && typeof value === "object"
      && value.source === "couple-room-shell"
      && value.protocolVersion === PROTOCOL_VERSION
      && typeof value.type === "string"
      && typeof value.id === "string"
      && value.nonce === nonce;
  }

  var allowedRawKeys = {
    mute: true,
    mic: true,
    camera: true,
    speaker: true,
    volume: true,
    bitrate: true,
    audiobitrate: true,
    reload: true,
    close: true,
    toggleSettings: true,
    getStats: true,
    getDetailedState: true,
    getStreamIDs: true,
    getDeviceList: true,
    changeVideoDevice: true,
    changeVideoDeviceId: true,
    changeAudioDevice: true,
    target: true,
    action: true,
    value: true,
    sendChat: true,
    sendData: true,
    type: true,
    UUID: true,
    streamID: true,
    cib: true
  };

  function allowedCommand(command) {
    if (!command || typeof command !== "object" || Array.isArray(command)) return false;
    var keys = Object.keys(command);
    if (!keys.length || keys.some(function (key) { return !allowedRawKeys[key]; })) return false;
    if (command.action && ["togglescreenshare", "coupleRoomWallpaper", "coupleRoomLayout", "coupleRoomSpaceDrag"].indexOf(command.action) === -1) return false;
    if (command.sendChat && (typeof command.sendChat !== "string" || command.sendChat.length > 4096)) return false;
    if (command.action === "coupleRoomLayout" && !validLayoutValue(command.value)) return false;
    if (command.action === "coupleRoomSpaceDrag" && typeof command.value !== "boolean") return false;
    return true;
  }

  function validLayoutValue(value) {
    if (!value || typeof value !== "object" || ["auto", "custom"].indexOf(value.mode) === -1) return false;
    if (!Array.isArray(value.placements) || value.placements.length > 30) return false;
    return value.placements.every(function (placement) {
      if (!placement || typeof placement !== "object") return false;
      if (typeof placement.tileId !== "string" || !placement.tileId || placement.tileId.length > 180) return false;
      if (!placement.bounds || typeof placement.bounds !== "object") return false;
      var values = [
        placement.bounds.x,
        placement.bounds.y,
        placement.bounds.width,
        placement.bounds.height
      ];
      if (!values.every(function (number) { return Number.isFinite(number) && number >= 0 && number <= 1; })) return false;
      if (["cover", "contain"].indexOf(placement.fit) === -1) return false;
      return Number.isFinite(placement.zIndex) && placement.zIndex >= 0 && placement.zIndex <= 100;
    });
  }

  function executeCommand(command, event) {
    if (!allowedCommand(command)) {
      post("command.rejected", { reason: "forbidden-command" });
      return;
    }
    if (command.action === "coupleRoomLayout") {
      setLayout(command.value);
      return;
    }
    if (command.action === "coupleRoomSpaceDrag") {
      setSpaceDragCursor(command.value);
      return;
    }
    if (typeof command.mic === "boolean") {
      localAudioMuted = !command.mic;
      scheduleRefresh();
    }
    if ((command.close || command.hangup) && !hangupSent) notifyHangup("parent-command");
    if (session && typeof session.remoteInterfaceAPI === "function") {
      session.remoteInterfaceAPI({
        data: command,
        origin: event.origin,
        source: event.source
      });
    }
  }

  window.addEventListener("message", function (event) {
    if (!isTrustedParent(event)) {
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }

    if (isEnvelope(event.data)) {
      event.stopImmediatePropagation();
      event.preventDefault();
      if (event.data.type === "bridge.hello") {
        var versions = event.data.payload && event.data.payload.supportedVersions;
        if (!Array.isArray(versions) || versions.indexOf(PROTOCOL_VERSION) === -1) {
          post("bridge.unsupported", { supportedVersions: [PROTOCOL_VERSION] }, event.data.id);
          return;
        }
        post("bridge.ready", {
          selectedVersion: PROTOCOL_VERSION,
          adapterVersion: ADAPTER_VERSION,
          capabilities: {
            commands: true,
            connectionState: true,
            participantState: true,
            tileState: true,
            layoutState: true,
            fileState: true,
            originValidation: opaqueParent ? "source-and-nonce" : "exact"
          }
        }, event.data.id);
        scheduleRefresh();
        return;
      }
      if (event.data.type === "command.execute") {
        executeCommand(event.data.payload && event.data.payload.command, event);
      }
      return;
    }

    if (!allowedCommand(event.data)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  }, true);

  function setWallpaper(value) {
    var wallpapers = ["default", "sea", "purple", "camping", "space", "romance"];
    var wallpaper = typeof value === "string" ? value : "default";
    if (wallpapers.indexOf(wallpaper) === -1) return false;
    if (wallpaper === "default") {
      document.documentElement.style.removeProperty("--couple-room-wallpaper-image");
    } else {
      document.documentElement.style.setProperty(
        "--couple-room-wallpaper-image",
        'url("./media/couple-room/wallpapers/' + wallpaper + '.webp")'
      );
    }
    document.documentElement.dataset.coupleRoomWallpaper = wallpaper;
    return wallpaper;
  }

  var currentLayout = { mode: "auto", placements: [] };

  function stableTileId(container, video, order) {
    if (tileIds.has(container)) return tileIds.get(container);
    var streamId = video && video.dataset && (video.dataset.sid || video.dataset.streamid);
    var uuid = video && video.dataset && (video.dataset.UUID || video.dataset.uuid);
    var kind = container.classList.contains("is-screenshare") ? "screen" : "camera";
    var identity = String(streamId || uuid || container.id || order).slice(0, 120);
    var tileId = kind + ":" + identity + ":" + (++tileIdSequence);
    tileIds.set(container, tileId);
    return tileId;
  }

  function tileContainers() {
    return Array.prototype.slice.call(document.querySelectorAll(".container_holder_video")).filter(function (container) {
      var video = container.querySelector("video");
      if (!video) return false;
      if (container.id === "minipreview") return false;
      if (video.id === "previewWebcam" || video.closest("#previewWebcamContainer")) return false;
      return true;
    });
  }

  function cleanTileChrome() {
    tileContainers().forEach(function (container) {
      var video = container.querySelector("video");
      if (video) video.removeAttribute("title");
    });
  }

  function clearContainerLayout(container) {
    [
      "--couple-room-x",
      "--couple-room-y",
      "--couple-room-width",
      "--couple-room-height",
      "--couple-room-z"
    ].forEach(function (property) {
      container.style.removeProperty(property);
    });
    delete container.dataset.coupleRoomPlaced;
    var video = container.querySelector("video");
    if (video) video.style.removeProperty("--couple-room-fit");
  }

  function setVariable(element, property, value) {
    if (element.style.getPropertyValue(property) === value) return;
    element.style.setProperty(property, value);
  }

  function applyCurrentLayout() {
    var containers = tileContainers();
    var byId = {};
    containers.forEach(function (container, order) {
      var video = container.querySelector("video");
      var tileId = stableTileId(container, video, order);
      container.dataset.coupleRoomTileId = tileId;
      byId[tileId] = { container: container, video: video };
    });

    if (currentLayout.mode !== "custom") {
      containers.forEach(clearContainerLayout);
      document.documentElement.dataset.coupleRoomLayout = "auto";
      return;
    }

    document.documentElement.dataset.coupleRoomLayout = "custom";
    var placedIds = {};
    currentLayout.placements.forEach(function (placement) {
      var target = byId[placement.tileId];
      if (!target) return;
      placedIds[placement.tileId] = true;
      var bounds = placement.bounds;
      target.container.dataset.coupleRoomPlaced = "1";
      setVariable(target.container, "--couple-room-x", (bounds.x * 100) + "%");
      setVariable(target.container, "--couple-room-y", (bounds.y * 100) + "%");
      setVariable(target.container, "--couple-room-width", (bounds.width * 100) + "%");
      setVariable(target.container, "--couple-room-height", (bounds.height * 100) + "%");
      setVariable(target.container, "--couple-room-z", String(placement.zIndex || 1));
      if (target.video) setVariable(target.video, "--couple-room-fit", placement.fit);
    });
    Object.keys(byId).forEach(function (tileId) {
      if (!placedIds[tileId]) clearContainerLayout(byId[tileId].container);
    });
  }

  function setLayout(value) {
    if (!validLayoutValue(value)) return false;
    currentLayout = {
      mode: value.mode,
      placements: value.placements.map(function (placement) {
        return {
          tileId: placement.tileId,
          order: placement.order,
          bounds: {
            x: placement.bounds.x,
            y: placement.bounds.y,
            width: placement.bounds.width,
            height: placement.bounds.height
          },
          fit: placement.fit,
          zIndex: placement.zIndex
        };
      })
    };
    applyCurrentLayout();
    scheduleRefresh();
    return true;
  }

  if (window.Commands) {
    window.Commands.coupleRoomWallpaper = setWallpaper;
    window.Commands.coupleRoomLayout = setLayout;
    window.Commands.togglescreenshare = function () {
      screenshareTypeDecider(session.screenshareType || (session.roomid ? 3 : 1));
      return session.screenShareState;
    };
  }

  window.updateUserList = function () {
    removeHiddenUsers();
  };

  window.getChatMessage = function (msg, label, director, overlay, UUID) {
    if (typeof msg === "string" && msg.indexOf(PREFIX) === 0) {
      if (msg.length > 4096) return;
      var data = {
        time: Date.now(),
        msg: msg,
        label: label ? String(label).slice(0, 120) : "",
        type: "recv"
      };
      window.parent.postMessage({ gotChat: data, chat: data, coupleRoomEvent: true }, targetOrigin);
      return;
    }
    return originalGetChatMessage.apply(this, arguments);
  };

  function removeHiddenUsers() {
    var nodes = document.querySelectorAll("#connectUsers,#closedList_connectUsers");
    for (var i = 0; i < nodes.length; i += 1) nodes[i].remove();
  }

  function notifyHangup(reason) {
    if (hangupSent) return;
    hangupSent = true;
    post("connection.state", {
      revision: ++revision,
      phase: "left",
      peerCount: 0,
      reason: reason || "vdo-hangup",
      lastChange: Date.now()
    });
    window.parent.postMessage({
      action: "couple-room-hangup",
      type: "couple-room.hangup",
      reason: reason || "vdo-hangup"
    }, targetOrigin);
  }

  function setImportant(element, property, value) {
    if (
      element.style.getPropertyValue(property) === value
      && element.style.getPropertyPriority(property) === "important"
    ) {
      return;
    }
    element.style.setProperty(property, value, "important");
  }

  function positionLabels() {
    var labels = document.querySelectorAll(".holder .video-label.toprounded");
    for (var i = 0; i < labels.length; i += 1) {
      var label = labels[i];
      var holder = label.closest(".holder");
      var video = holder && holder.querySelector("video");
      var offsetParent = label.offsetParent;
      if (!video || !offsetParent) continue;
      var videoRect = video.getBoundingClientRect();
      var parentRect = offsetParent.getBoundingClientRect();
      var contentLeft = videoRect.left;
      var contentTop = videoRect.top;
      var contentWidth = videoRect.width;
      var contentHeight = videoRect.height;
      var fit = window.getComputedStyle(video).objectFit;
      if ((fit === "contain" || fit === "scale-down") && video.videoWidth && video.videoHeight) {
        var sourceRatio = video.videoWidth / video.videoHeight;
        var boxRatio = videoRect.width / videoRect.height;
        if (boxRatio > sourceRatio) {
          contentWidth = videoRect.height * sourceRatio;
          contentLeft += (videoRect.width - contentWidth) / 2;
        } else {
          contentHeight = videoRect.width / sourceRatio;
          contentTop += (videoRect.height - contentHeight) / 2;
        }
      }
      setImportant(label, "top", "auto");
      setImportant(label, "bottom", Math.max(0, parentRect.bottom - contentTop - contentHeight + 5) + "px");
      setImportant(label, "left", Math.max(0, contentLeft - parentRect.left + 5) + "px");
      setImportant(label, "max-width", Math.max(0, contentWidth - 10) + "px");
    }
  }

  function remoteAudioIsMuted(video, muteState) {
    var uuid = video && video.dataset && (video.dataset.UUID || video.dataset.uuid);
    var peer = uuid && window.session && session.rpcs && session.rpcs[uuid];
    if (peer && typeof peer.remoteMuteState !== "undefined") {
      return Boolean(peer.remoteMuteState);
    }
    return Boolean(
      muteState
      && !muteState.classList.contains("hidden")
      && !muteState.classList.contains("hidden2")
      && !muteState.classList.contains("unmuted")
    );
  }

  function syncRemoteMuteDecorations() {
    var containers = document.querySelectorAll(".container_holder_video.is-not-screenshare");
    for (var i = 0; i < containers.length; i += 1) {
      var container = containers[i];
      var holder = container.querySelector(".holder");
      var video = holder && holder.querySelector("video");
      if (!holder || !video) continue;

      var muteStates = holder.querySelectorAll(".video-mute-state");
      var muteState = null;
      for (var j = 0; j < muteStates.length; j += 1) {
        if (muteStates[j].querySelector(".la-microphone-slash")) {
          muteState = muteStates[j];
          muteState.classList.add("couple-room-native-mute-state");
          break;
        }
      }

      var muted = video.id === "videosource"
        ? localAudioMuted
        : remoteAudioIsMuted(video, muteState);
      if (muted) {
        container.dataset.coupleRoomAudioMuted = "1";
      } else {
        delete container.dataset.coupleRoomAudioMuted;
      }
    }
  }

  function normalizedBounds(element) {
    var rect = element.getBoundingClientRect();
    var width = Math.max(1, window.innerWidth);
    var height = Math.max(1, window.innerHeight);
    return {
      x: Math.max(0, Math.min(1, rect.left / width)),
      y: Math.max(0, Math.min(1, rect.top / height)),
      width: Math.max(0, Math.min(1, rect.width / width)),
      height: Math.max(0, Math.min(1, rect.height / height))
    };
  }

  function collectParticipants() {
    var participants = [];
    var peers = (window.session && session.rpcs) || {};
    Object.keys(peers).forEach(function (peerId) {
      var peer = peers[peerId] || {};
      participants.push({
        id: peerId,
        streamId: peer.streamID || undefined,
        label: String(peer.label || peer.streamID || "Partner").slice(0, 120),
        role: peer.screenShare ? "screen" : "guest",
        audio: peer.audio === false ? "absent" : peer.muted ? "muted" : "live",
        video: peer.video === false ? "absent" : peer.videoMuted ? "muted" : "live",
        connection: peer.closed ? "closed" : peer.reconnecting ? "reconnecting" : peer.connected === false ? "connecting" : "connected"
      });
    });
    return participants;
  }

  function collectTiles() {
    return tileContainers().map(function (container, order) {
      var holder = container.querySelector(".holder") || container;
      var video = container.querySelector("video");
      var label = holder.querySelector(".video-label");
      var idValue = stableTileId(container, video, order);
      var fit = video ? window.getComputedStyle(video).objectFit : "none";
      return {
        id: idValue,
        participantId: (video && video.dataset && (video.dataset.UUID || video.dataset.uuid)) || holder.dataset.uuid || undefined,
        streamId: (video && video.dataset && (video.dataset.sid || video.dataset.streamid)) || holder.dataset.streamid || undefined,
        mediaKind: container.classList.contains("is-screenshare") ? "screen" : video ? "camera" : "unknown",
        visible: container.getClientRects().length > 0,
        muted: Boolean(video && video.muted),
        fit: ["cover", "contain", "fill", "scale-down", "none"].indexOf(fit) >= 0 ? fit : "none",
        aspectRatio: video && video.videoWidth > 0 && video.videoHeight > 0
          ? video.videoWidth / video.videoHeight
          : undefined,
        order: order,
        label: label ? label.textContent.slice(0, 120) : undefined,
        bounds: normalizedBounds(container)
      };
    });
  }

  function collectFiles() {
    var hosted = (window.session && Array.isArray(session.hostedFiles)) ? session.hostedFiles : [];
    var progressNodes = document.querySelectorAll(".file-item .progress-text");
    return hosted.map(function (file, index) {
      var progressText = progressNodes[index] && progressNodes[index].textContent || "0";
      var progress = Math.max(0, Math.min(1, (parseFloat(progressText) || 0) / 100));
      return {
        id: String(file.id || "file-" + index).slice(0, 180),
        name: String(file.name || "Shared file").slice(0, 255),
        mime: file.type ? String(file.type).slice(0, 120) : undefined,
        direction: "send",
        peerId: file.restricted || undefined,
        size: Number.isFinite(file.size) ? Math.max(0, file.size) : 0,
        progress: progress,
        speed: 0,
        state: file.state === 0 ? "cancelled" : progress >= 1 ? "complete" : progress > 0 ? "transferring" : "queued"
      };
    });
  }

  function emitSnapshots() {
    var participants = collectParticipants();
    var tiles = collectTiles();
    var files = collectFiles();
    var phase = session && session.roomid
      ? (participants.length ? "connected" : "joining")
      : "idle";
    var connection = {
      revision: ++revision,
      phase: phase,
      peerCount: participants.length,
      localStreamId: session && session.streamID || undefined,
      lastChange: Date.now()
    };
    var layout = {
      revision: revision,
      mode: document.documentElement.dataset.coupleRoomLayout === "custom" ? "custom" : "auto",
      placements: tiles.map(function (tile) {
        return { tileId: tile.id, order: tile.order, bounds: tile.bounds };
      })
    };
    var signature = JSON.stringify([connection.phase, participants, tiles, layout, files]);
    if (signature === lastStateSignature) return;
    lastStateSignature = signature;
    post("connection.state", connection);
    post("participants.state", { revision: revision, participants: participants });
    post("tiles.state", { revision: revision, tiles: tiles });
    post("layout.state", layout);
    post("files.state", { revision: revision, files: files });
  }

  function hasVisibleHangup() {
    var nodes = document.querySelectorAll("#hangupContainer");
    for (var i = 0; i < nodes.length; i += 1) {
      var style = window.getComputedStyle(nodes[i]);
      if (style.display !== "none" && style.visibility !== "hidden" && nodes[i].getClientRects().length) return true;
    }
    return false;
  }

  function refresh() {
    framePending = false;
    removeHiddenUsers();
    cleanTileChrome();
    applyCurrentLayout();
    positionLabels();
    syncRemoteMuteDecorations();
    if (hasVisibleHangup()) notifyHangup("vdo-hangup-screen");
    emitSnapshots();
  }

  function scheduleRefresh() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(refresh);
  }

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-streamid", "data-uuid", "data-sid"]
  });
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("contextmenu", function (event) {
    if (event.target && event.target.closest && event.target.closest(".container_holder_video")) {
      event.preventDefault();
    }
  }, true);
  window.addEventListener("beforeunload", function () { notifyHangup("page-unload"); });
  removeHiddenUsers();
  scheduleRefresh();

  if (typeof originalUpdateUserList === "function") {
    originalUpdateUserList = originalUpdateUserList.bind(window);
  }
})();
