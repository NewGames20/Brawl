(function () {
  if (window.__brawlMultiplayerFixInstalled) return;
  window.__brawlMultiplayerFixInstalled = true;

  const fixState = {
    lastPacketSeq: new Map(),
    connectedAt: new Map(),
    nextSeq: 0
  };

  function normalizePeerId(id) {
    return String(id || '').trim();
  }

  function nextNetworkSeq(type = 'msg') {
    const key = String(type || 'msg');
    const current = Number(fixState.lastPacketSeq.get(key) || 0);
    const next = current + 1;
    fixState.lastPacketSeq.set(key, next);
    return next;
  }

  function registerPacket(id, type, seq) {
    if (!id) return false;
    const key = `${normalizePeerId(id)}:${String(type || 'msg')}`;
    const current = Number(fixState.lastPacketSeq.get(key) || -1);
    if (Number(seq) <= current) return false;
    fixState.lastPacketSeq.set(key, Number(seq));
    return true;
  }

  function cleanupRemoteActorById(id) {
    const peerId = normalizePeerId(id);
    if (!peerId) return;

    if (typeof peerConnections !== 'undefined' && peerConnections instanceof Map) {
      peerConnections.delete(peerId);
    }

    if (typeof roster !== 'undefined') {
      const idx = roster.findIndex((r) => normalizePeerId(r && r.id) === peerId);
      if (idx >= 0) roster.splice(idx, 1);
    }

    if (typeof E !== 'undefined') {
      for (let i = E.length - 1; i >= 0; i--) {
        const ent = E[i];
        if (normalizePeerId(ent && ent.netId) === peerId) {
          if (ent.mesh) {
            try { scene.remove(ent.mesh); } catch (e) {}
            if (ent.mesh && ent.mesh.geometry) ent.mesh.geometry.dispose();
            if (ent.mesh && ent.mesh.material) ent.mesh.material.dispose();
          }
          E.splice(i, 1);
        }
      }
    }

    if (typeof P !== 'undefined') {
      for (let i = P.length - 1; i >= 0; i--) {
        const shot = P[i];
        if (normalizePeerId(shot && shot.o && shot.o.netId) === peerId) {
          try { if (shot.mesh) scene.remove(shot.mesh); } catch (e) {}
          P.splice(i, 1);
        }
      }
    }

    fixState.connectedAt.delete(peerId);
    fixState.lastPacketSeq.delete(`${peerId}:SYNC_POS`);
    fixState.lastPacketSeq.delete(`${peerId}:SYNC_HP`);
    fixState.lastPacketSeq.delete(`${peerId}:ACT`);
  }

  function removeRemotePlayerFromRosterOrScene(peerId) {
    const id = normalizePeerId(peerId);
    if (!id) return;

    if (typeof roster !== 'undefined') {
      for (let i = roster.length - 1; i >= 0; i--) {
        if (normalizePeerId(roster[i] && roster[i].id) === id) {
          roster.splice(i, 1);
        }
      }
    }

    if (typeof E !== 'undefined') {
      for (let i = E.length - 1; i >= 0; i--) {
        const ent = E[i];
        if (normalizePeerId(ent && ent.netId) === id) {
          if (ent.mesh) {
            try { scene.remove(ent.mesh); } catch (e) {}
            if (ent.mesh && ent.mesh.geometry) ent.mesh.geometry.dispose();
            if (ent.mesh && ent.mesh.material) ent.mesh.material.dispose();
          }
          E.splice(i, 1);
        }
      }
    }
  }

  function isDuplicateRemotePlayer(id, heroIndex) {
    if (typeof E === 'undefined') return false;
    const peerId = normalizePeerId(id);
    return E.some((ent) => normalizePeerId(ent && ent.netId) === peerId && Number(ent.ci) === Number(heroIndex));
  }

  function safeRemoteEnemyLookup(id) {
    if (typeof E === 'undefined') return null;
    return E.find((ent) => normalizePeerId(ent && ent.netId) === normalizePeerId(id)) || null;
  }

  function strongMuteDuplicateMsg(type, senderId, seq) {
    if (!senderId || Number(seq) === undefined || Number.isNaN(Number(seq))) return false;
    const key = `${normalizePeerId(senderId)}:${String(type || 'msg')}`;
    const last = Number(fixState.lastPacketSeq.get(key) || -1);
    if (Number(seq) <= last) return true;
    fixState.lastPacketSeq.set(key, Number(seq));
    return false;
  }

  function applyNetSyncState(data) {
    if (!data || !data.id) return;
    const safeId = normalizePeerId(data.id);
    if (!safeId) return;

    let ent = safeRemoteEnemyLookup(safeId);
    if (!ent) {
      const heroIndex = Number(data.hero || data.ci || 0);
      if (typeof mk === 'function') {
        ent = mk(heroIndex, Number(data.x || 0), Number(data.z || 0), 2, safeId);
      }
      if (!ent) return;
      if (typeof E !== 'undefined') E.push(ent);
    }

    ent.x = Number(data.x ?? ent.x ?? 0);
    ent.z = Number(data.z ?? ent.z ?? 0);
    ent.a = Number(data.a ?? ent.a ?? 0);
    ent.hp = Number(data.hp ?? ent.hp ?? ent.mhp ?? 0);
    ent.dead = !!data.dead;
    ent.netId = safeId;

    if (ent.mesh) {
      ent.mesh.position.set(ent.x, 0, ent.z);
      ent.mesh.rotation.y = -ent.a + Math.PI / 2;
    }

    if (ent.dead && ent.mesh) ent.mesh.visible = false;
    if (!ent.dead && ent.mesh) ent.mesh.visible = true;
  }

  function wrapBroadcast(obj) {
    if (!obj || typeof obj !== 'object') return;
    const type = String(obj.type || 'msg');
    const seq = Number(obj.seq ?? ++fixState.nextSeq);
    const payload = Object.assign({}, obj, { seq, sentAt: Date.now() });
    return payload;
  }

  window.broadcastToPeers = function broadcastToPeers(obj) {
    if (!obj || typeof obj !== 'object') return;
    const payload = wrapBroadcast(obj);
    if (!payload || typeof peerConnections === 'undefined' || !(peerConnections instanceof Map)) return;
    peerConnections.forEach((conn) => {
      if (conn && conn.open) conn.send(payload);
    });
  };

  function assignConnectionHandlers(conn) {
    if (!conn) return;

    conn.on('open', () => {
      if (typeof peerConnections !== 'undefined' && peerConnections instanceof Map) {
        peerConnections.set(conn.peer, conn);
      }
      if (typeof roster !== 'undefined') {
        const local = roster.find((r) => normalizePeerId(r && r.id) === myNetId);
        const hero = local ? local.hero : p1HeroChoice;
        conn.send({ type: 'HELLO', id: myNetId, hero: hero });
      }
    });

    conn.on('data', (data) => {
      if (typeof handleIncomingData === 'function') handleIncomingData(conn, data);
    });

    conn.on('close', () => {
      cleanupRemoteActorById(conn.peer);
      if (typeof isLobbyLeader !== 'undefined' && isLobbyLeader) {
        if (typeof electNewLeader === 'function') electNewLeader(conn.peer);
      }
    });

    conn.on('error', () => {
      cleanupRemoteActorById(conn.peer);
    });
  }

  window.setupConnectionEvents = function setupConnectionEvents(conn) {
    assignConnectionHandlers(conn);
  };

  window.handleIncomingData = function handleIncomingData(conn, data) {
    if (!data || typeof data !== 'object') return;
    const senderId = normalizePeerId((data.id || (conn && conn.peer) || ''));
    const type = String(data.type || 'msg');
    const seq = Number(data.seq ?? -1);

    if (senderId && seq >= 0 && strongMuteDuplicateMsg(type, senderId, seq)) {
      return;
    }

    if (type === 'HELLO') {
      const hero = Number(data.hero ?? p1HeroChoice ?? 0);
      const exists = typeof roster !== 'undefined' && roster.some((r) => normalizePeerId(r && r.id) === senderId);
      if (!exists) {
        roster.push({ id: senderId, hero });
      }
      if (typeof isLobbyLeader !== 'undefined' && isLobbyLeader) {
        broadcastToPeers({ type: 'ROSTER_SYNC', roster, leaderId });
      }
      if (typeof state !== 'undefined' && state === 'menu') refreshLobbyMenu();
      return;
    }

    if (type === 'ROSTER_SYNC') {
      if (Array.isArray(data.roster)) {
        roster = data.roster;
      }
      if (data.leaderId) leaderId = data.leaderId;
      if (typeof refreshLobbyMenu === 'function') refreshLobbyMenu();
      return;
    }

    if (type === 'LEADER_ELECTED') {
      leaderId = data.leaderId || leaderId;
      isLobbyLeader = normalizePeerId(myNetId) === normalizePeerId(leaderId);
      if (typeof refreshLobbyMenu === 'function') refreshLobbyMenu();
      return;
    }

    if (type === 'START_GAME') {
      selectedMapIndex = Number(data.mapIndex ?? selectedMapIndex ?? 0);
      if (typeof launchMeshMatch === 'function') launchMeshMatch();
      return;
    }

    if (type === 'SYNC_POS') {
      if (!senderId) return;
      if (typeof data.x === 'undefined' || typeof data.z === 'undefined') return;
      const ent = safeRemoteEnemyLookup(senderId);
      if (ent) {
        ent.x = Number(data.x);
        ent.z = Number(data.z);
        ent.a = Number(data.a ?? ent.a ?? 0);
        ent.netId = senderId;
      }
      return;
    }

    if (type === 'SYNC_HP') {
      const ent = safeRemoteEnemyLookup(senderId);
      if (ent) {
        ent.hp = Number(data.hp ?? ent.hp ?? 0);
        ent.dead = !!data.dead;
        if (ent.dead && ent.mesh) ent.mesh.visible = false;
        if (!ent.dead && ent.mesh) ent.mesh.visible = true;
      }
      return;
    }

    if (type === 'ACT') {
      const ent = safeRemoteEnemyLookup(senderId);
      if (!ent) return;
      if (data.act === 'ATTACK') {
        if (typeof executeAttack === 'function') executeAttack(ent);
      } else if (data.act === 'AB1') {
        if (typeof executeAbility1 === 'function') executeAbility1(ent);
      } else if (data.act === 'AB2') {
        if (typeof executeAbility2 === 'function') executeAbility2(ent);
      }
      return;
    }

    if (type === 'REJOIN') {
      cleanupRemoteActorById(senderId);
      return;
    }

    if (type === 'PING') {
      if (conn && conn.open) conn.send({ type: 'PONG', id: myNetId });
      return;
    }

    if (type === 'PONG') {
      fixState.connectedAt.set(senderId, Date.now());
      return;
    }
  };

  if (typeof setInterval === 'function') {
    setInterval(() => {
      if (!peerConnections || !(peerConnections instanceof Map)) return;
      const now = Date.now();
      peerConnections.forEach((conn, id) => {
        if (!conn || !conn.open) return;
        const lastSeen = fixState.connectedAt.get(id) || now;
        if (now - lastSeen > 2500) {
          cleanupRemoteActorById(id);
          try { conn.close(); } catch (e) {}
        }
      });
    }, 1000);
  }
})();

// If the file is loaded before the game code fully initializes, this stub keeps the JS from crashing.
if (typeof window !== 'undefined' && !window.__brawlMultiplayerFixRuntimeGuard) {
  window.__brawlMultiplayerFixRuntimeGuard = true;
}
