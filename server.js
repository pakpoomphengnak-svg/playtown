// ─────────────────────────────────────────────
// PLAYTOWN Multiplayer Server
// server.js
// ─────────────────────────────────────────────

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');

const app    = express();
const server = http.createServer(app);

// ── CORS: อนุญาตทุก origin (ปรับเป็น domain จริงตอน production) ──
app.use(cors());

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // ping เพื่อเช็คว่า client ยังอยู่ (สำคัญสำหรับเกม real-time)
  pingTimeout:  20000,
  pingInterval: 10000,
});

// ── Game State ─────────────────────────────────
// players: Map<socketId, PlayerData>
const players = new Map();

// ── Market Price State ─────────────────────────
const MARKET_PRICE_RANGE = {
  apple_packaged: { min: 100, max: 200 },
  juice_grape: { min: 150, max: 300 },
  woodplank: { min: 200, max: 400 },
  ironingot: { min: 250, max: 500 },
  goldingot: { min: 300, max: 600 },
  diamond: { min: 350, max: 700 },
};
const MARKET_REROLL_MINUTES = 5;
const MARKET_REROLL_MS      = MARKET_REROLL_MINUTES * 60 * 1000;

let marketState = {
  prices:    rollMarketPrices(),
  rolledAt:  Date.now(),
  nextRollAt: Date.now() + MARKET_REROLL_MS,
};

function rollMarketPrices() {
  const prices = {};
  for (const [id, { min, max }] of Object.entries(MARKET_PRICE_RANGE)) {
    prices[id] = Math.floor(Math.random() * (max - min + 1)) + min;
  }
  return prices;
}

// รีราคาตลาดทุก MARKET_REROLL_MINUTES นาที และ broadcast ให้ทุกคน
setInterval(() => {
  marketState = {
    prices:     rollMarketPrices(),
    rolledAt:   Date.now(),
    nextRollAt: Date.now() + MARKET_REROLL_MS,
  };
  io.emit('marketPrices', marketState);
  console.log('[Market] Prices rerolled:', marketState.prices);
}, MARKET_REROLL_MS);

// ── Health Check (Railway ต้องการ endpoint นี้) ──
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    players: players.size,
    uptime: Math.floor(process.uptime()),
  });
});

// ── Socket.IO Events ───────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}  (total: ${players.size + 1})`);

  // 1. ส่ง id ของตัวเองกลับไป
  socket.emit('selfId', { id: socket.id });

  // 2. ส่งรายชื่อผู้เล่นที่มีอยู่แล้วให้คนใหม่
  socket.emit('currentPlayers', [...players.values()]);

  // 3. ส่งราคาตลาดปัจจุบันให้คนที่เพิ่ง connect
  socket.emit('marketPrices', marketState);

  // ── เข้าร่วมเกม ────────────────────────────
  socket.on('playerJoin', (data) => {
    const player = {
      id:          socket.id,
      name:        sanitize(data.name) || 'Player',
      gender:      data.gender === 'female' ? 'female' : 'male',
      x:           clamp(data.x,    -490, 490),
      z:           clamp(data.z,    -490, 490),
      rotY:        data.rotY   || 0,
      isInVehicle: false,
      vehicleId:   null,
      joinedAt:    Date.now(),
    };

    players.set(socket.id, player);

    // แจ้งทุกคนว่ามีคนใหม่เข้ามา (ยกเว้นตัวเอง)
    socket.broadcast.emit('playerJoined', player);

    console.log(`[Join] ${player.name} at (${player.x.toFixed(1)}, ${player.z.toFixed(1)})`);
  });

  // ── อัปเดตตำแหน่ง ──────────────────────────
  socket.on('updatePosition', (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    // อัปเดต state บน server
    player.x           = clamp(data.x, -490, 490);
    player.z           = clamp(data.z, -490, 490);
    player.rotY        = data.rotY        || 0;
    player.isInVehicle = data.isInVehicle || false;
    player.vehicleId   = data.vehicleId   || null;
    player.isSprinting = data.isSprinting || false;
    player.isAttacking = data.isAttacking || false;

    // broadcast ไปคนอื่น (ไม่ต้องส่งกลับตัวเอง)
    socket.broadcast.emit('playerMoved', {
      id:          socket.id,
      x:           player.x,
      z:           player.z,
      rotY:        player.rotY,
      isInVehicle: player.isInVehicle,
      vehicleId:   player.vehicleId,
      isSprinting: player.isSprinting,
      isAttacking: player.isAttacking,
    });
  });

  // ── Disconnect ─────────────────────────────
  socket.on('disconnect', (reason) => {
    const player = players.get(socket.id);
    if (player) {
      console.log(`[-] Left: ${player.name} (${reason})`);
      players.delete(socket.id);
      io.emit('playerLeft', { id: socket.id });
    }
  });
});

// ── Helpers ────────────────────────────────────
function clamp(val, min, max) {
  const n = parseFloat(val);
  if (isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&]/g, '').trim().slice(0, 20);
}

// ── Start ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 PLAYTOWN Server running on port ${PORT}`);
});
