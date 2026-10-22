(function () {
  if (window.__brawlNetFixInstalled) return;
  window.__brawlNetFixInstalled = true;

  const netFix = {
    packetSeq: new Map(),
    lastSeen: new Map(),
    nextSeq: 1,
    remoteActorCache: new Map(),
    lastRemoteHealth: new Map(),
    cleanupTimers: new Map()
  };

  function k(id) {
    return String(id ?? '').trim();
  }

  function getRemoteActor(id) {
    if (typeof E === 'undefined') return null;
    const key = k(id);
    return E.find((ent) => k(ent && ent.netId) === key) || null;
  }

  function deleteRemoteActor(id, silent = false) {
    if (typeof E === 'undefined') return;
    const key = k(id);
    for (let i = E.length - 1; i >= 0; i--) {
      const ent = E[i];
      if (k(ent && ent.netId) !== key) continue;
      if (ent.mesh) {
        try { scene.remove(ent.mesh); } catch (e) {}
        if (ent.mesh && ent.mesh.geometry) ent.mesh.geometry.dispose();
        if (ent.mesh && ent.mesh.material) {
          const mats = Array.isArray(ent.mesh.material) ? ent.mesh.material : [ent.mesh.material];
          mats.forEach((m) => m && m.dispose && m.dispose());
        }
      }
      E.splice(i, 1);
      if (!silent) {
        netFix.lastRemoteHealth.delete(key);
      }
      netFix.remoteActorCache.delete(key);
      break;
    }

    if (typeof roster !== 'undefined') {
      for (let i = roster.length - 1; i >= 0; i--) {
        if (k(roster[i] && roster[i].id) === key) roster.splice(i, 1);
      }
    }
  }

  function acceptPacket(type, senderId, seq) {
    const senderKey = k(senderId);
    if (!senderKey || Number.isNaN(Number(seq))) return true;
    const key = `${senderKey}:${String(type || 'msg')}`;
    const last = Number(netFix.packetSeq.get(key) || -1);
    const nextSeq = Number(seq);
    if (nextSeq <= last) return false;
    netFix.packetSeq.set(key, nextSeq);
    netFix.lastSeen.set(senderKey, Date.now());
    return true;
  }

  function ensureBaseRemoteEntity(id, heroValue, x, z) {
    if (!id) return null;
    const existing = getRemoteActor(id);
    if (existing) return existing;

    if (typeof mk === 'function') {
      const heroIndex = Number(heroValue ?? 0);
      const ent = mk(heroIndex, Number(x || 0), Number(z || 0), 2, id);
      if (ent) {
        ent.netId = k(id);
        ent.dead = false;
        if (ent.mesh) ent.mesh.visible = true;
        return ent;
      }
    }
    return null;
  }

  const originalMk = typeof window.mk === 'function' ? window.mk : null;
  if (originalMk) {
    window.mk = function patchedMk(ci, x, z, playerNum, netId = null) {
      const netKey = k(netId);
      if (netKey && typeof E !== 'undefined') {
        const existing = E.find((ent) => k(ent && ent.netId) === netKey);
        if (existing) {
          existing.ci = Number(ci ?? existing.ci ?? 0);
          existing.x = Number(x ?? existing.x ?? 0);
          existing.z = Number(z ?? existing.z ?? 0);
          existing.hp = Number(existing.hp ?? existing.mhp ?? 0);
          existing.dead = false;
          if (existing.mesh) existing.mesh.visible = true;
          return existing;
        }
      }
      return originalMk.call(this, ci, x, z, playerNum, netId);
    };
  }

  const originalBroadcast = typeof window.broadcastToPeers === 'function' ? window.broadcastToPeers : null;
  window.broadcastToPeers = function patchedBroadcast(obj) {
    if (!obj || typeof obj !== 'object') return;
    const payload = Object.assign({}, obj, {
      id: obj.id || myNetId,
      seq: Number(obj.seq ?? (++netFix.nextSeq)),
      sentAt: Date.now()
    });

    if (typeof originalBroadcast === 'function') {
      return originalBroadcast.call(this, payload);
    }

    if (typeof peerConnections !== 'undefined' && peerConnections instanceof Map) {
      peerConnections.forEach((conn) => {
        if (conn && conn.open) conn.send(payload);
      });
    }
  };

  const originalHandleIncoming = typeof window.handleIncomingData === 'function' ? window.handleIncomingData : null;
  window.handleIncomingData = function patchedHandleIncoming(conn, data) {
    if (!data || typeof data !== 'object') return originalHandleIncoming ? originalHandleIncoming.call(this, conn, data) : undefined;

    const senderId = k((data.id || (conn && conn.peer) || ''));
    const packetType = String(data.type || 'msg');
    const seq = Number(data.seq ?? -1);

    if (senderId && packetType && !acceptPacket(packetType, senderId, seq)) {
      return;
    }

    if (packetType === 'HELLO') {
      if (!senderId) return;
      const hero = Number(data.hero ?? p1HeroChoice ?? 0);
      const rosterEntry = Array.isArray(roster) ? roster.find((r) => k(r && r.id) === senderId) : null;
      if (!rosterEntry) {
        if (!Array.isArray(roster)) roster = [];
        roster.push({ id: senderId, hero });
      } else {
        rosterEntry.hero = hero;
      }
      if (typeof refreshLobbyMenu === 'function') refreshLobbyMenu();
      return;
    }

    if (packetType === 'ROSTER_SYNC') {
      if (Array.isArray(data.roster)) roster = data.roster;
      if (data.leaderId) leaderId = data.leaderId;
      if (typeof refreshLobbyMenu === 'function') refreshLobbyMenu();
      return;
    }

    if (packetType === 'SYNC_POS') {
      if (!senderId || data.x === undefined || data.z === undefined) return;
      const ent = ensureBaseRemoteEntity(senderId, data.hero ?? 0, data.x, data.z);
      if (!ent) return;
      ent.x = Number(data.x);
      ent.z = Number(data.z);
      ent.a = Number(data.a ?? ent.a ?? 0);
      ent.netId = senderId;
      if (ent.dead && ent.mesh) ent.mesh.visible = false;
      if (!ent.dead && ent.mesh) ent.mesh.visible = true;
      return;
    }

    if (packetType === 'SYNC_HP') {
      if (!senderId) return;
      const ent = getRemoteActor(senderId) || ensureBaseRemoteEntity(senderId, data.hero ?? 0, data.x ?? 0, data.z ?? 0);
      if (!ent) return;
      ent.hp = Number(data.hp ?? ent.hp ?? ent.mhp ?? 0);
      ent.dead = !!data.dead;
      netFix.lastRemoteHealth.set(senderId, ent.hp);
      if (ent.dead && ent.mesh) ent.mesh.visible = false;
      if (!ent.dead && ent.mesh) ent.mesh.visible = true;
      return;
    }

    if (packetType === 'ACT') {
      const ent = getRemoteActor(senderId) || ensureBaseRemoteEntity(senderId, data.hero ?? 0, data.x ?? 0, data.z ?? 0);
      if (!ent) return;
      if (data.act === 'ATTACK' && typeof executeAttack === 'function') executeAttack(ent);
      if (data.act === 'AB1' && typeof executeAbility1 === 'function') executeAbility1(ent);
      if (data.act === 'AB2' && typeof executeAbility2 === 'function') executeAbility2(ent);
      return;
    }

    if (packetType === 'LEADER_ELECTED') {
      if (data.leaderId) leaderId = data.leaderId;
      isLobbyLeader = k(myNetId) === k(leaderId);
      if (typeof refreshLobbyMenu === 'function') refreshLobbyMenu();
      return;
    }

    if (packetType === 'START_GAME') {
      if (typeof launchMeshMatch === 'function') launchMeshMatch();
      return;
    }

    if (packetType === 'PING') {
      if (conn && conn.open) conn.send({ type: 'PONG', id: myNetId, seq: Number(++netFix.nextSeq) });
      return;
    }

    if (packetType === 'PONG') {
      netFix.lastSeen.set(senderId, Date.now());
      return;
    }

    if (packetType === 'REJOIN') {
      deleteRemoteActor(senderId, true);
      return;
    }

    if (originalHandleIncoming) {
      return originalHandleIncoming.call(this, conn, data);
    }
  };

  if (typeof setInterval === 'function') {
    setInterval(() => {
      if (typeof peerConnections === 'undefined' || !(peerConnections instanceof Map)) return;
      const now = Date.now();
      peerConnections.forEach((conn, peerId) => {
        if (!conn || !conn.open) return;
        const lastSeen = netFix.lastSeen.get(peerId) || now;
        if (now - lastSeen > 2500) {
          deleteRemoteActor(peerId);
          try { conn.close(); } catch (e) {}
          peerConnections.delete(peerId);
        }
      });
    }, 1000);
  }

  const originalSetupConnectionEvents = typeof window.setupConnectionEvents === 'function' ? window.setupConnectionEvents : null;
  if (originalSetupConnectionEvents) {
    window.setupConnectionEvents = function patchedSetupConnectionEvents(conn) {
      if (conn && conn.peer) {
        netFix.lastSeen.set(k(conn.peer), Date.now());
      }
      return originalSetupConnectionEvents.call(this, conn);
    };
  }
})();
