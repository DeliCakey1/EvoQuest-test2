/**
 * EvoQuest Multiplayer Server — PartyKit
 *
 * Handles:
 *  - Player join / leave
 *  - Position + state broadcasting (~20 updates/sec per player)
 *  - Kill/death events with XP relay
 *  - Periodic full-state sync for new joiners
 */

export default class EvoQuestParty {
  constructor(room) {
    this.room = room;
    this.players = new Map(); // id -> player state
  }

  onConnect(conn, ctx) {
    // Send current state to new joiner
    if (this.players.size > 0) {
      conn.send(JSON.stringify({
        type: 'state',
        players: Array.from(this.players.values()),
      }));
    }
  }

  onMessage(message, sender) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    switch (msg.type) {
      case 'ping':
        sender.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'join': {
        const player = {
          id: msg.id || sender.id,
          name: sanitize(msg.name) || 'Player',
          x: 1500, y: 1500,
          level: 0, totalXp: 0, score: 0,
          alive: true,
        };
        this.players.set(player.id, player);
        // Announce to others
        this.broadcast(JSON.stringify({ type: 'player_update', ...player }), sender.id);
        break;
      }

      case 'player_update': {
        const existing = this.players.get(msg.id);
        if (!existing) break; // must join first
        const updated = {
          ...existing,
          x: clamp(msg.x, 0, 3000),
          y: clamp(msg.y, 0, 3000),
          level: clamp(msg.level || 0, 0, 99),
          totalXp: msg.totalXp || 0,
          score: msg.score || 0,
          name: sanitize(msg.name) || existing.name,
          alive: msg.alive !== false,
        };
        this.players.set(msg.id, updated);
        // Relay to all other clients
        this.broadcast(JSON.stringify({ type: 'player_update', ...updated }), sender.id);
        break;
      }

      case 'kill': {
        // msg.id killed msg.victimId
        const killer = this.players.get(msg.id);
        const victim = this.players.get(msg.victimId);
        if (!killer || !victim) break;
        const xpGain = Math.floor((victim.totalXp || 0) * 0.25);
        // Update killer
        killer.totalXp = (killer.totalXp || 0) + xpGain;
        killer.score = (killer.score || 0) + xpGain + 25;
        // Mark victim dead
        victim.alive = false;
        this.players.set(msg.id, killer);
        this.players.set(msg.victimId, victim);
        // Broadcast kill event to everyone
        this.room.broadcast(JSON.stringify({
          type: 'kill_event',
          killerId: msg.id,
          killerName: killer.name,
          victimId: msg.victimId,
          victimName: victim.name,
          victimXp: xpGain,
        }));
        break;
      }

      case 'death': {
        const p = this.players.get(msg.id);
        if (p) { p.alive = false; this.players.set(msg.id, p); }
        this.broadcast(JSON.stringify({ type: 'player_update', ...p, alive: false }), sender.id);
        break;
      }

      default:
        break;
    }
  }

  onClose(conn) {
    // Find player by conn id or iterate
    for (const [id, p] of this.players) {
      if (id === conn.id || p._connId === conn.id) {
        this.players.delete(id);
        this.room.broadcast(JSON.stringify({ type: 'player_left', id }));
        break;
      }
    }
    // Also try by sender's connection id matching message id
    // PartyKit uses conn.id as the connection identifier
    this.players.delete(conn.id);
    this.room.broadcast(JSON.stringify({ type: 'player_left', id: conn.id }));
  }

  broadcast(message, excludeId) {
    for (const conn of this.room.getConnections()) {
      if (conn.id !== excludeId) {
        try { conn.send(message); } catch (_) {}
      }
    }
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v) || 0));
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"']/g, '').slice(0, 20).trim();
}
