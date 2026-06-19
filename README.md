# PLAYTOWN Server

Multiplayer server สำหรับเกม PLAYTOWN ใช้ Node.js + Socket.IO

## วิธี Deploy บน Railway

1. Push โฟลเดอร์นี้ขึ้น GitHub repo ใหม่
2. ใน Railway → New Project → Deploy from GitHub repo
3. เลือก repo นี้ → Railway จะ detect Node.js อัตโนมัติ
4. รอ deploy เสร็จ → คัดลอก URL ที่ได้ (เช่น `https://playtown-xxx.railway.app`)
5. นำ URL ไปใส่ใน `socketClient.js` ฝั่ง client

## วิธีรันใน Local

```bash
npm install
npm run dev   # ใช้ nodemon (auto-restart)
# หรือ
npm start
```

Server จะรันที่ http://localhost:3000

## Endpoints

- `GET /` → health check (แสดงจำนวนผู้เล่นออนไลน์)

## Socket Events

| Event (client → server) | ข้อมูล |
|---|---|
| `playerJoin` | `{ name, x, z, rotY }` |
| `updatePosition` | `{ x, z, rotY, isInVehicle, vehicleId }` |

| Event (server → client) | ข้อมูล |
|---|---|
| `selfId` | `{ id }` |
| `currentPlayers` | `[...players]` |
| `playerJoined` | player object |
| `playerMoved` | `{ id, x, z, rotY, isInVehicle }` |
| `playerLeft` | `{ id }` |
