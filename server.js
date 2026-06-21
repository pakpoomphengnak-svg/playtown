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

// vehicles: Map<plate, VehicleData>
// VehicleData = { plate, type, x, z, rotY, colorHex, fuel, driverId, spawned }
// "spawned" = false หมายถึงรถจอดอยู่ในการาจ (ไม่อยู่ในโลก/ไม่ broadcast ตำแหน่ง)
const vehicles = new Map();
const PLATE_RE = /^[A-Z0-9]{1,12}$/;       // ทะเบียนรถ: ตัวพิมพ์ใหญ่/เลขเท่านั้น
const VEHICLE_TYPE_RE = /^[a-z0-9_]{1,30}$/; // type รถ: a-z, 0-9, _
const COLOR_HEX_RE = /^#[0-9a-fA-F]{6}$/;     // สีรถ: hex 6 หลัก เช่น #ff0000

// ── PvP Config ──────────────────────────────────
const PVP_MAX_HP             = 100;
const PVP_MAX_DAMAGE         = 100;  // กันส่งดาเมจมั่ว/โกง — ดาเมจสูงสุดต่อการตี 1 ครั้งที่ server ยอมรับ
const PVP_HIT_RANGE          = 3.0;  // ระยะตีสูงสุดที่ server ยอมรับ (กว้างกว่า client เล็กน้อยกันมือสั่น/network jitter)
const PVP_ATTACK_COOLDOWN_MS = 250;  // คูลดาวน์ขั้นต่ำระหว่างการตีของผู้เล่นคนเดียวกัน (กันสแปม)
const PVP_RESPAWN_X          = 110;
const PVP_RESPAWN_Z          = 70;

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
    vehiclesSpawned: [...vehicles.values()].filter(v => v.spawned).length,
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

  // 2b. ส่งรายชื่อรถที่ "อยู่ในโลก" (spawned) ทั้งหมดให้คนใหม่ (รถที่จอดในการาจไม่ต้องส่ง)
  socket.emit('currentVehicles', [...vehicles.values()].filter(v => v.spawned));

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
      weaponId:    null,
      joinedAt:    Date.now(),
      // ── PvP ──
      hp:            PVP_MAX_HP,
      maxHp:         PVP_MAX_HP,
      isDead:        false,
      _lastAttackAt: 0, // เวลา (ms) ที่ตีโดนล่าสุด — ใช้คุม cooldown กันสแปม
    };

    players.set(socket.id, player);

    // แจ้งทุกคนว่ามีคนใหม่เข้ามา (ยกเว้นตัวเอง)
    socket.broadcast.emit('playerJoined', player);

    console.log(`[Join] ${player.name} at (${player.x.toFixed(1)}, ${player.z.toFixed(1)})`);
  });

  // ── เบิกรถออกจากการาจ (spawn เข้าโลก) ──────
  // client ส่งมาหลัง local Garage.retrieveVehicle() ตรวจสิทธิ์ผ่านแล้ว (เหมือนระบบเศรษฐกิจอื่นๆ ในเกมที่ฝั่ง client เป็นผู้ตัดสิน)
  // server แค่เก็บ state กลางให้ทุกคนเห็นรถตรงกัน + กัน payload ผิดรูป
  socket.on('vehicleRetrieve', (data) => {
    const plate = sanitizePlate(data && data.plate);
    const type  = sanitizeVehicleType(data && data.type);
    if (!plate || !type) return;

    const existing = vehicles.get(plate);
    // กันรถคันเดียวกันถูกเบิกซ้ำซ้อนจากสอง client พร้อมกัน (คันนี้อยู่ในโลกอยู่แล้ว)
    if (existing && existing.spawned) return;

    const vehicle = {
      plate,
      type,
      x:        clamp(data.x, -494, 494),
      z:        clamp(data.z, -494, 494),
      rotY:     data.rotY || 0,
      colorHex: existing ? existing.colorHex : null,
      fuel:     (existing && typeof existing.fuel === 'number') ? existing.fuel : (typeof data.fuel === 'number' ? data.fuel : 100),
      // ── เชื่อค่า locked ที่ client (เจ้าของรถ) ส่งมาก่อนเสมอ — client เป็นผู้ตัดสินสถานะล็อกจริง
      //    ผ่าน VehicleLock ที่เก็บถาวรไว้ในเครื่อง (เหมือนระบบอื่นๆ ที่ client ตัดสิน)
      //    ตกกลับไปใช้ค่าที่ server จำไว้ก่อนหน้า (existing) เฉพาะกรณี client เก่าที่ยังไม่ส่ง locked มา
      locked:   (typeof data.locked === 'boolean') ? data.locked : (existing ? !!existing.locked : false),
      driverId: null,
      spawned:  true,
      // ── คนที่เพิ่งเบิกรถคันนี้ออกมา (เจ้าของ) — ให้สิทธิ์ขึ้นรถได้ทันทีแม้ล็อกอยู่ ──
      // (garage.js auto เข้ารถให้ทันทีหลังเบิก ไม่ผ่าน UI เช็คล็อกตามปกติ)
      // ให้สิทธิ์เฉพาะตอน client บอกว่าจะ auto-enter ทันทีเท่านั้น (กันเป็นช่องโหว่ค้างไว้ใช้ทีหลัง)
      retrieverId: data.autoEnter ? socket.id : null,
    };
    vehicles.set(plate, vehicle);

    io.emit('vehicleSpawned', vehicle); // รวมตัวเองด้วย เผื่อกรณี client อื่นอ้างอิง state กลางนี้

    console.log(`[Vehicle] ${plate} (${type}) spawned by ${socket.id}`);
  });

  // ── เก็บรถเข้าการาจ (despawn ออกจากโลก) ─────
  socket.on('vehicleStore', (data) => {
    const plate = sanitizePlate(data && data.plate);
    if (!plate) return;
    const vehicle = vehicles.get(plate);
    if (!vehicle || !vehicle.spawned) return;

    vehicle.spawned    = false;
    vehicle.driverId   = null;
    vehicle.retrieverId = null;

    io.emit('vehicleDespawned', { plate });
  });

  // ── เปลี่ยนสีรถ (จาก tuning shop) ────────────
  socket.on('vehicleColor', (data) => {
    const plate    = sanitizePlate(data && data.plate);
    const colorHex = sanitizeColorHex(data && data.colorHex);
    if (!plate || !colorHex) return;
    const vehicle = vehicles.get(plate);
    if (!vehicle) return;

    vehicle.colorHex = colorHex;
    io.emit('vehicleColorChanged', { plate, colorHex });
  });

  // ── ล็อก/ปลดล็อกรถ ───────────────────────────
  // client ส่งมาหลัง local VehicleLock ตรวจสิทธิ์กุญแจผ่านแล้ว (เหมือนระบบอื่นๆ ที่ client เป็นผู้ตัดสิน)
  // ห้ามล็อก/ปลดล็อกรถระหว่างมีคนขับอยู่ (กันแกล้งล็อกใส่คนที่กำลังขับ/แย่งปลดล็อกรถคนอื่นขับ)
  socket.on('vehicleLock', (data) => {
    const plate  = sanitizePlate(data && data.plate);
    if (!plate) return;
    const locked = !!(data && data.locked);
    const vehicle = vehicles.get(plate);
    if (!vehicle) return;
    if (vehicle.driverId && vehicle.driverId !== socket.id) return; // มีคนอื่นขับอยู่ ห้ามยุ่ง

    vehicle.locked = locked;
    io.emit('vehicleLockChanged', { plate, locked });
  });

  // ── ขึ้นรถ (กลายเป็นคนขับ) ───────────────────
  socket.on('vehicleEnter', (data) => {
    const plate = sanitizePlate(data && data.plate);
    if (!plate) return;
    const vehicle = vehicles.get(plate);
    if (!vehicle || !vehicle.spawned) return;
    if (vehicle.driverId && vehicle.driverId !== socket.id) return; // มีคนขับอยู่แล้ว

    // รถถูกล็อกอยู่ — ห้ามขึ้น เว้นแต่เป็นคนที่เพิ่งเบิกรถคันนี้ออกมาเอง (auto-enter ตอนเบิก)
    const isRetriever = vehicle.retrieverId === socket.id;
    if (vehicle.locked && !isRetriever) return;
    vehicle.retrieverId = null; // ใช้สิทธิ์ bypass ได้แค่ครั้งเดียวตอนเบิกเท่านั้น กันใช้ซ้ำเป็นช่องโหว่ข้ามล็อกถาวร

    vehicle.driverId = socket.id;
    io.emit('vehicleDriverChanged', { plate, driverId: socket.id });
  });

  // ── ลงรถ (เลิกเป็นคนขับ) ─────────────────────
  socket.on('vehicleExit', (data) => {
    const plate = sanitizePlate(data && data.plate);
    if (!plate) return;
    const vehicle = vehicles.get(plate);
    if (!vehicle || vehicle.driverId !== socket.id) return;

    vehicle.driverId = null;
    if (typeof data.x === 'number')    vehicle.x    = clamp(data.x, -494, 494);
    if (typeof data.z === 'number')    vehicle.z    = clamp(data.z, -494, 494);
    if (typeof data.rotY === 'number') vehicle.rotY = data.rotY;

    io.emit('vehicleDriverChanged', { plate, driverId: null, x: vehicle.x, z: vehicle.z, rotY: vehicle.rotY });
  });

  // ── อัปเดตตำแหน่งรถ (ส่งเฉพาะตอนเป็นคนขับ) ──
  socket.on('updateVehiclePosition', (data) => {
    const plate = sanitizePlate(data && data.plate);
    if (!plate) return;
    const vehicle = vehicles.get(plate);
    // ต้องเป็นคนขับจริงของรถคันนี้ถึงจะอัปเดตตำแหน่งได้ (กัน client อื่นปลอม)
    if (!vehicle || !vehicle.spawned || vehicle.driverId !== socket.id) return;

    vehicle.x    = clamp(data.x, -494, 494);
    vehicle.z    = clamp(data.z, -494, 494);
    vehicle.rotY = data.rotY || 0;
    vehicle.speed = typeof data.speed === 'number' ? data.speed : 0;
    if (typeof data.fuel === 'number') vehicle.fuel = Math.max(0, Math.min(data.fuel, 1000));

    socket.broadcast.emit('vehicleMoved', {
      plate,
      x:     vehicle.x,
      z:     vehicle.z,
      rotY:  vehicle.rotY,
      speed: vehicle.speed,
      fuel:  vehicle.fuel,
    });
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
    player.weaponId    = sanitizeWeaponId(data.weaponId);

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
      weaponId:    player.weaponId,
    });
  });

  // ── PvP: โจมตีผู้เล่นอื่น ─────────────────────
  // client (ผู้โจมตี) ส่ง targetId + damage มา — server เป็นผู้ตัดสินสุดท้ายเสมอ:
  // เช็คว่าทั้งคู่ยังมีอยู่จริง, ไม่ตายอยู่แล้ว, ไม่ได้อยู่ในรถ, ระยะห่างไม่เกิน PVP_HIT_RANGE,
  // ดาเมจไม่เกิน PVP_MAX_DAMAGE, และไม่ตีถี่เกิน cooldown — กันโกงจากฝั่ง client ผู้โจมตี
  socket.on('attackPlayer', (data) => {
    const attacker = players.get(socket.id);
    if (!attacker || attacker.isDead) return;

    const targetId = (data && typeof data.targetId === 'string') ? data.targetId : null;
    if (!targetId || targetId === socket.id) return;

    const target = players.get(targetId);
    if (!target || target.isDead) return;
    if (attacker.isInVehicle || target.isInVehicle) return; // ตียิงทะลุรถไม่ได้

    // ── ระยะ ──
    const dx = target.x - attacker.x;
    const dz = target.z - attacker.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > PVP_HIT_RANGE) return;

    // ── cooldown กันสแปม (ต่อผู้โจมตีคนนี้) ──
    const now = Date.now();
    if (now - attacker._lastAttackAt < PVP_ATTACK_COOLDOWN_MS) return;
    attacker._lastAttackAt = now;

    // ── ดาเมจ: clamp ให้อยู่ในช่วงที่ยอมรับได้เสมอ ──
    let damage = parseFloat(data && data.damage);
    if (isNaN(damage) || damage <= 0) return;
    damage = Math.min(damage, PVP_MAX_DAMAGE);

    const weaponId = sanitizeWeaponId(data && data.weaponId);

    target.hp = Math.max(0, target.hp - damage);

    // ── แจ้งเป้าหมายว่าโดนตี (เฉพาะเป้าหมายเท่านั้นที่ต้องหัก HP จริงฝั่งตัวเอง) ──
    io.to(targetId).emit('playerHit', {
      attackerId: socket.id,
      damage,
      weaponId,
      hp:         target.hp,
    });

    // ── แจ้งทุกคน (รวม attacker) ว่า HP ของเป้าหมายเปลี่ยน ไว้ sync UI เช่นหลอดเลือดเหนือหัว ──
    io.emit('playerHpChanged', { id: targetId, hp: target.hp });

    console.log(`[PvP] ${attacker.name} → ${target.name}: -${damage} HP (เหลือ ${target.hp})`);

    // ── ตาย ──
    if (target.hp <= 0 && !target.isDead) {
      target.isDead = true;
      io.emit('playerDied', { id: targetId, killerId: socket.id });
      console.log(`[PvP] ${target.name} เสียชีวิต (โดน ${attacker.name})`);
    }
  });

  // ── PvP: ฟื้นคืนชีพ ───────────────────────────
  socket.on('playerRespawn', () => {
    const player = players.get(socket.id);
    if (!player || !player.isDead) return;

    player.isDead = false;
    player.hp     = player.maxHp;
    player.x      = PVP_RESPAWN_X;
    player.z      = PVP_RESPAWN_Z;

    io.emit('playerRespawned', { id: socket.id, x: player.x, z: player.z });
    console.log(`[PvP] ${player.name} ฟื้นคืนชีพ`);
  });

  // ── Disconnect ─────────────────────────────
  socket.on('disconnect', (reason) => {
    const player = players.get(socket.id);
    if (player) {
      console.log(`[-] Left: ${player.name} (${reason})`);
      players.delete(socket.id);
      io.emit('playerLeft', { id: socket.id });
    }

    // ── ถ้าผู้เล่นที่หลุดกำลังขับรถอยู่ ปล่อยรถคันนั้นทิ้งไว้ในโลก (ไม่มีคนขับ) ──
    for (const vehicle of vehicles.values()) {
      if (vehicle.driverId === socket.id) {
        vehicle.driverId = null;
        io.emit('vehicleDriverChanged', { plate: vehicle.plate, driverId: null, x: vehicle.x, z: vehicle.z, rotY: vehicle.rotY });
      }
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

// weaponId ต้องเป็น string สั้นๆ ที่ปลอดภัย (a-z, 0-9, _, -) หรือไม่มีอาวุธ (null)
// กันกรณี client ส่งค่าผิดรูป (object, string ยาวเกิน, อักขระแปลกๆ) มา broadcast ต่อให้คนอื่น
function sanitizeWeaponId(weaponId) {
  if (typeof weaponId !== 'string') return null;
  const trimmed = weaponId.trim().slice(0, 30);
  if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

// plate (ทะเบียนรถ) มาจาก Dealership._generatePlate() ฝั่ง client เสมอ รูปแบบ AAA1234 (ตัวพิมพ์ใหญ่ + เลข)
function sanitizePlate(plate) {
  if (typeof plate !== 'string') return null;
  const trimmed = plate.trim().toUpperCase().slice(0, 12);
  return PLATE_RE.test(trimmed) ? trimmed : null;
}

// type ต้องตรงกับ key ใน VEHICLE_TYPES/DEALERSHIP_CATALOG ฝั่ง client (a-z, 0-9, _)
function sanitizeVehicleType(type) {
  if (typeof type !== 'string') return null;
  const trimmed = type.trim().slice(0, 30);
  return VEHICLE_TYPE_RE.test(trimmed) ? trimmed : null;
}

// สีรถต้องเป็น hex 6 หลักรูปแบบ #rrggbb เท่านั้น
function sanitizeColorHex(colorHex) {
  if (typeof colorHex !== 'string') return null;
  const trimmed = colorHex.trim();
  return COLOR_HEX_RE.test(trimmed) ? trimmed : null;
}

// ── Start ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 PLAYTOWN Server running on port ${PORT}`);
});
