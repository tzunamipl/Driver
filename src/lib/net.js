// One shared room for the static GitHub Pages build. Pages can't host a
// server, so browsers publish poses to a public MQTT broker over WebSocket.
// Each client simulates its own car; everyone else is an interpolated mesh.
// The broker is best-effort: if it drops, driving still works solo.

import mqtt from 'mqtt';

const BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';
const POSE_TOPIC = 'tzunamipl/driver/v1/pose';
const WORLD_TOPIC = 'tzunamipl/driver/v1/world';

const PUBLISH_INTERVAL_MS = 100;
const PEER_TIMEOUT_MS = 2000;
const INTERP_DELAY_MS = 150;
const SAMPLE_KEEP_MS = 1000;
const TELEPORT_DISTANCE = 40;
const CONNECT_TIMEOUT_MS = 4000;
const RETAIN_WAIT_MS = 700;
const SPAWN_RADIUS = 6;

export function createNet() {
  const clientId = crypto.randomUUID();
  const peers = new Map();
  const statusListeners = new Set();
  const originListeners = new Set();

  let client = null;
  let connected = false;
  let lastPublish = 0;
  let originTime = 0;
  let playerName = '';
  let playerColor = 0x1c3f94;

  function emitStatus(status) {
    for (const fn of statusListeners) fn(status);
  }

  function onStatus(fn) {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
  }

  function onOrigin(fn) {
    originListeners.add(fn);
    return () => originListeners.delete(fn);
  }

  function spawnOffset() {
    let hash = 0;
    for (let i = 0; i < clientId.length; i++) hash = (Math.imul(hash, 31) + clientId.charCodeAt(i)) >>> 0;
    const angle = ((hash % 360) * Math.PI) / 180;
    return { x: Math.cos(angle) * SPAWN_RADIUS, z: Math.sin(angle) * SPAWN_RADIUS };
  }

  function publish(topic, payload, retain) {
    if (!client || !connected) return;
    client.publish(topic, JSON.stringify(payload), { qos: 0, retain });
  }

  function publishPose(pose) {
    const now = performance.now();
    if (now - lastPublish < PUBLISH_INTERVAL_MS) return;
    lastPublish = now;
    publish(POSE_TOPIC, {
      id: clientId,
      name: playerName,
      color: playerColor,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      qx: pose.qx,
      qy: pose.qy,
      qz: pose.qz,
      qw: pose.qw,
      speed: pose.speed,
      steer: pose.steer,
    }, false);
  }

  function publishOrigin(lat, lon) {
    const t = Math.max(Date.now(), originTime + 1);
    originTime = t;
    publish(WORLD_TOPIC, { id: clientId, lat, lon, t }, true);
  }

  function publishLeave() {
    publish(POSE_TOPIC, { id: clientId, leave: true }, false);
  }

  function acceptOrigin(msg) {
    if (!msg || msg.id === clientId) return false;
    if (!Number.isFinite(msg.t) || !Number.isFinite(msg.lat) || !Number.isFinite(msg.lon)) return false;
    if (msg.lat < -90 || msg.lat > 90 || msg.lon < -180 || msg.lon > 180) return false;
    if (msg.t < originTime) return false;
    if (msg.t === originTime && String(msg.id) <= clientId) return false;
    originTime = msg.t;
    return true;
  }

  function handlePose(msg) {
    if (!msg || msg.id === clientId) return;
    if (msg.leave) {
      peers.delete(msg.id);
      return;
    }
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || !Number.isFinite(msg.z)) return;
    if (!Number.isFinite(msg.qx) || !Number.isFinite(msg.qy) || !Number.isFinite(msg.qz) || !Number.isFinite(msg.qw)) return;

    let peer = peers.get(msg.id);
    if (!peer) {
      peer = { name: '', color: 0x1c3f94, lastSeen: 0, samples: [] };
      peers.set(msg.id, peer);
    }
    peer.name = sanitizeName(msg.name);
    peer.color = sanitizeColor(msg.color);
    peer.lastSeen = performance.now();

    const sample = {
      recv: peer.lastSeen,
      x: msg.x,
      y: msg.y,
      z: msg.z,
      qx: msg.qx,
      qy: msg.qy,
      qz: msg.qz,
      qw: msg.qw,
      speed: Number.isFinite(msg.speed) ? msg.speed : 0,
      steer: Number.isFinite(msg.steer) ? msg.steer : 0,
    };
    const last = peer.samples[peer.samples.length - 1];
    if (last) {
      const dx = sample.x - last.x;
      const dy = sample.y - last.y;
      const dz = sample.z - last.z;
      if (dx * dx + dy * dy + dz * dz > TELEPORT_DISTANCE * TELEPORT_DISTANCE) peer.samples.length = 0;
    }
    peer.samples.push(sample);
    const cutoff = sample.recv - SAMPLE_KEEP_MS;
    while (peer.samples.length > 2 && peer.samples[0].recv < cutoff) peer.samples.shift();
  }

  function handleMessage(topic, payload) {
    let msg;
    try {
      const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (topic === WORLD_TOPIC) {
      if (acceptOrigin(msg)) {
        for (const fn of originListeners) fn({ lat: msg.lat, lon: msg.lon });
      }
      return;
    }
    if (topic === POSE_TOPIC) handlePose(msg);
  }

  function connect({ name, color }) {
    playerName = sanitizeName(name);
    playerColor = sanitizeColor(color);
    emitStatus('connecting');

    client = mqtt.connect(BROKER_URL, {
      // MQTT 3.1.1 brokers reject client ids longer than 23 bytes.
      clientId: clientId.replace(/-/g, '').slice(0, 23),
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 2000,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });
    client.on('connect', () => {
      connected = true;
      emitStatus('online');
      client.subscribe([POSE_TOPIC, WORLD_TOPIC]);
    });
    client.on('close', () => {
      connected = false;
      emitStatus('offline');
    });
    client.on('error', () => {
      connected = false;
      emitStatus('offline');
    });
    client.on('message', handleMessage);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (online) => {
        if (settled) return;
        settled = true;
        resolve(online);
      };
      const giveUp = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
      client.on('connect', () => {
        clearTimeout(giveUp);
        setTimeout(() => finish(true), RETAIN_WAIT_MS);
      });
    });
  }

  function isOnline() {
    return connected;
  }

  function remotePoses(now) {
    const renderT = now - INTERP_DELAY_MS;
    const poses = [];
    for (const [id, peer] of peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        peers.delete(id);
        continue;
      }
      const pose = interpolate(peer.samples, renderT);
      if (!pose) continue;
      poses.push({ id, name: peer.name, color: peer.color, ...pose });
    }
    return poses;
  }

  return {
    clientId,
    spawnOffset,
    connect,
    publishPose,
    publishOrigin,
    publishLeave,
    isOnline,
    remotePoses,
    onStatus,
    onOrigin,
  };
}

function interpolate(samples, renderT) {
  if (!samples.length) return null;
  if (samples.length === 1 || renderT <= samples[0].recv) return samples[0];
  const last = samples[samples.length - 1];
  if (renderT >= last.recv) return last;

  let i = 1;
  while (i < samples.length && samples[i].recv < renderT) i++;
  const a = samples[i - 1];
  const b = samples[i];
  const span = b.recv - a.recv;
  const u = span > 0 ? (renderT - a.recv) / span : 1;
  const quat = slerpQuat(a, b, u);
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    qx: quat.x,
    qy: quat.y,
    qz: quat.z,
    qw: quat.w,
    speed: a.speed + (b.speed - a.speed) * u,
    steer: a.steer + (b.steer - a.steer) * u,
  };
}

function slerpQuat(a, b, t) {
  let bx = b.qx;
  let by = b.qy;
  let bz = b.qz;
  let bw = b.qw;
  let dot = a.qx * bx + a.qy * by + a.qz * bz + a.qw * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    const x = a.qx + (bx - a.qx) * t;
    const y = a.qy + (by - a.qy) * t;
    const z = a.qz + (bz - a.qz) * t;
    const w = a.qw + (bw - a.qw) * t;
    const len = Math.hypot(x, y, z, w) || 1;
    return { x: x / len, y: y / len, z: z / len, w: w / len };
  }
  const theta = Math.acos(Math.min(1, dot));
  const sin = Math.sin(theta);
  const w1 = Math.sin((1 - t) * theta) / sin;
  const w2 = Math.sin(t * theta) / sin;
  return {
    x: a.qx * w1 + bx * w2,
    y: a.qy * w1 + by * w2,
    z: a.qz * w1 + bz * w2,
    w: a.qw * w1 + bw * w2,
  };
}

function sanitizeName(name) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return text || 'driver';
}

function sanitizeColor(color) {
  const n = Number(color);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffff) return 0x1c3f94;
  return n;
}
