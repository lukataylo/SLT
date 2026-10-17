import Anthropic from '@anthropic-ai/sdk';

// Hive Vision's agents. The firefighter agent briefs one responder about
// their team relative to where they stand; the coordinator agent briefs the
// incident coordinator about everyone. Both read the live situation (map,
// rooms, doorways, every phone's position and heading, recent events).
// With ANTHROPIC_API_KEY set, Claude writes the answer; without it, a
// rule-based briefing is returned, so the feature always works.

const MODEL = 'claude-opus-5-5';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function yawOf(q) {
  // forward = q · (0, 0, -1)
  const [x, y, z, w] = q;
  const fx = -(2 * (x * z + w * y));
  const fz = -(1 - 2 * (x * x + y * y));
  return Math.atan2(-fx, -fz);
}

function wallBetween(a, b, walls) {
  const cross = (p, q) => p[0] * q[1] - p[1] * q[0];
  const d = [b[0] - a[0], b[1] - a[1]];
  return walls.some((w) => {
    const e = [w[2] - w[0], w[3] - w[1]];
    const denom = cross(d, e);
    if (Math.abs(denom) < 1e-6) return false;
    const f = [w[0] - a[0], w[1] - a[1]];
    const t = cross(f, e) / denom;
    const u = cross(f, d) / denom;
    return t > 0.05 && t < 0.95 && u >= 0 && u <= 1;
  });
}

/** Clock direction from someone facing `yaw` towards a map point (12 = ahead, 3 = right). */
function clock(from, yaw, to) {
  const toward = Math.atan2(-(to[0] - from[0]), -(to[1] - from[1]));
  const rel = wrap(toward - yaw); // positive = to the left
  const hour = ((Math.round(-rel / (Math.PI / 6)) % 12) + 12) % 12;
  return hour === 0 ? 12 : hour;
}

/** The live situation as plain data, from one responder's point of view (or everyone's). */
export function situation(room, viewerId = null) {
  const now = room.now();
  const map = room.map.toJSON();
  const roomName = (id) => room.map.room(id)?.name ?? null;
  const people = [...room.peers.values()]
    .filter((p) => p.local)
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role === 'still' ? 'stationary camera' : 'moving',
      placed: !!p.alignment,
      online: now - (p.lastSeenAt ?? 0) < 5000,
      streaming: now - p.lastFrameAt < 5000,
      room: roomName(p.roomId) ?? (p.pose ? room.map.roomAt([p.pose.p[0], p.pose.p[2]])?.name ?? null : null),
      position: p.pose ? [Math.round(p.pose.p[0] * 10) / 10, Math.round(p.pose.p[2] * 10) / 10] : null,
      yaw: p.pose ? yawOf(p.pose.q) : null,
      stillForSeconds: p.lastMovedAt ? Math.round((now - p.lastMovedAt) / 1000) : null,
    }));
  const viewer = people.find((p) => p.id === viewerId) ?? null;
  const relative = (target) => {
    if (!viewer?.position || !target.position || viewer.yaw == null) return null;
    return {
      distanceM: Math.round(Math.hypot(target.position[0] - viewer.position[0], target.position[1] - viewer.position[1]) * 10) / 10,
      clock: clock(viewer.position, viewer.yaw, target.position),
      behindWall: wallBetween(viewer.position, target.position, map.walls),
    };
  };
  return {
    viewer: viewer && { name: viewer.name, room: viewer.room, placed: viewer.placed },
    team: people.filter((p) => p.id !== viewerId).map((p) => ({ ...p, yaw: undefined, fromYou: relative(p) })),
    rooms: map.rooms.map((r) => ({
      name: r.name,
      walls: r.walls.length,
      doors: r.openings.filter((o) => o.kind === 'door').length,
      windows: r.openings.filter((o) => o.kind === 'window').length,
    })),
    doorways: map.doorways.map((d) => ({
      state: d.state,
      widthM: d.width,
      fromYou: viewer?.position ? relative({ position: [(d.s[0] + d.s[2]) / 2, (d.s[1] + d.s[3]) / 2] }) : null,
    })),
    recentEvents: room.events.slice(-15).map((e) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.text}`),
  };
}

/** Rule-based briefing: always available, no network. */
export function ruleBrief(role, s) {
  const lines = [];
  if (role === 'firefighter') {
    if (!s.viewer?.placed) return 'You are not placed in the team yet. Scan a teammate’s code to join, then I can tell you where everyone is.';
    lines.push(`You are in ${s.viewer.room ?? 'an unmapped area'}.`);
    for (const p of s.team) {
      if (!p.online) { lines.push(`${p.name}: offline.`); continue; }
      if (!p.fromYou) { lines.push(`${p.name}: position unknown.`); continue; }
      lines.push(`${p.name}: ${p.fromYou.distanceM} m at ${p.fromYou.clock} o'clock${p.fromYou.behindWall ? ', behind a wall' : ''}${p.room ? `, in ${p.room}` : ''}${p.stillForSeconds > 60 ? `, not moved for ${p.stillForSeconds} s` : ''}.`);
    }
    const exits = s.doorways.filter((d) => d.state === 'open' && d.fromYou).sort((a, b) => a.fromYou.distanceM - b.fromYou.distanceM);
    if (exits[0]) lines.push(`Nearest open doorway: ${exits[0].fromYou.distanceM} m at ${exits[0].fromYou.clock} o'clock.`);
    if (!s.team.length) lines.push('No other team members connected.');
  } else {
    const online = s.team.filter((p) => p.online);
    lines.push(`${online.length} of ${s.team.length} responders online, ${s.rooms.length} rooms mapped.`);
    for (const p of s.team) {
      const where = p.room ? `in ${p.room}` : p.placed ? 'location unclear' : 'not placed';
      const flags = [!p.online && 'OFFLINE', p.online && !p.streaming && 'no video', p.stillForSeconds > 60 && `stationary ${p.stillForSeconds} s`, p.role === 'stationary camera' && 'fixed camera'].filter(Boolean);
      lines.push(`${p.name}: ${where}${flags.length ? ` (${flags.join(', ')})` : ''}.`);
    }
    const alerts = s.team.filter((p) => !p.online || (p.stillForSeconds > 120 && p.role === 'moving'));
    if (alerts.length) lines.push(`Check on: ${alerts.map((p) => p.name).join(', ')}.`);
  }
  return lines.join('\n');
}

const SYSTEM = {
  firefighter:
    'You are the Hive Vision field agent riding along with one firefighter inside a building. You receive live data: the ' +
    'building map from the team’s LiDAR scans, every teammate’s position relative to this firefighter (distance in metres, ' +
    'clock direction where 12 is straight ahead, and whether a wall is between them), doorways, and recent events. Answer in ' +
    'at most four short lines a firefighter can take in at a glance: positions as "Name, 4 m at 9 o’clock, behind wall". ' +
    'Use only the data given; if something is unknown, say so plainly. Never invent hazards, rooms or people.',
  coordinator:
    'You are the Hive Vision coordination agent supporting an incident coordinator watching a building response. You receive ' +
    'live data: the mapped rooms and doorways, every responder’s room, status (online, streaming video, stationary time, ' +
    'fixed camera or moving) and recent events. Give a crisp situation report or answer the question in at most six short ' +
    'lines: who is where, who needs attention and why, and coverage gaps. Use only the data given and say when something is unknown.',
};

let client = null;
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ??= new Anthropic();
  return client;
}

/** Answers a responder's or the coordinator's question (or gives a briefing). */
export async function ask(room, { role, peerId = null, question = '' }) {
  const kind = role === 'coordinator' ? 'coordinator' : 'firefighter';
  const s = situation(room, kind === 'firefighter' ? peerId : null);
  const fallbackText = ruleBrief(kind, s);
  const c = claude();
  if (!c) return { text: fallbackText, source: 'rules' };
  try {
    const response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 1024, // deliberately short field answers
      output_config: { effort: 'low' }, // fast replies; the data is small and structured
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM[kind],
      messages: [
        {
          role: 'user',
          content: `Live situation (JSON):\n${JSON.stringify(s)}\n\n${String(question).slice(0, 500) || 'Give me a briefing.'}`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') return { text: fallbackText, source: 'rules' };
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text: text || fallbackText, source: text ? 'claude' : 'rules' };
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.warn(`[agent] Claude API ${err.status}: ${err.message}`);
    else console.warn('[agent]', err.message);
    return { text: fallbackText, source: 'rules' };
  }
}
