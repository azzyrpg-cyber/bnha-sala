import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

function safeRoomId(raw) {
  return String(raw || "").trim().slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, "");
}
function ensureRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { masterSocketId: null, users: {}, sheets: {}, npcs: {}, rolls: [] });
  return rooms.get(roomId);
}
function userName(room, sid){ return room.users[sid]?.name || "Player"; }

function extractSummaryFromSheet(sheet){
  // Full sheet uses hp_now/pd_now; fallback to resources.hp/pd
  const hp = sheet?.hp_now ?? sheet?.resources?.hp ?? null;
  const pd = sheet?.pd_now ?? sheet?.resources?.pd ?? null;
  const name = sheet?.name ?? sheet?.character?.name ?? null;
  return { hp: hp!=="" ? Number(hp) : null, pd: pd!=="" ? Number(pd) : null, name: name || null };
}

function buildIndex(room){
  const list = [];
  for (const [sid, u] of Object.entries(room.users)){
    if (u.role !== "player") continue;
    const sh = room.sheets[sid];
    const s = sh ? extractSummaryFromSheet(sh) : { hp:null, pd:null, name:u.name };
    list.push({ id: sid, type: "player", name: s.name || u.name, hp: s.hp, pd: s.pd });
  }
  for (const [nid, sh] of Object.entries(room.npcs)){
    const s = extractSummaryFromSheet(sh);
    list.push({ id: nid, type: "npc", name: s.name || "NPC", hp: s.hp, pd: s.pd });
  }
  return list;
}

function emitIndex(roomId, room){
  io.to(room.masterSocketId).emit("room:sheetsIndex", { list: buildIndex(room) });
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ roomId, name }) => {
    const id = safeRoomId(roomId);
    if (!id) return socket.emit("error:msg", "Room ID inválido.");

    const room = ensureRoom(id);
    if (room.masterSocketId && room.users[room.masterSocketId]) {
      return socket.emit("error:msg", "Essa sala já tem mestre. Entre como Player.");
    }

    room.masterSocketId = socket.id;
    room.users[socket.id] = { name: String(name || "Mestre").slice(0, 40), role: "master" };
    socket.join(id);

    socket.emit("room:joined", { roomId: id, role: "master", socketId: socket.id });
    socket.emit("roll:history", { list: room.rolls || [] });
    emitIndex(id, room);
  });

  socket.on("room:join", ({ roomId, name }) => {
    const id = safeRoomId(roomId);
    if (!id) return socket.emit("error:msg", "Room ID inválido.");

    const room = rooms.get(id);
    if (!room || !room.masterSocketId) return socket.emit("error:msg", "Sala não existe (ou está sem mestre).");

    room.users[socket.id] = { name: String(name || "Player").slice(0, 40), role: "player" };
    socket.join(id);

    socket.emit("room:joined", { roomId: id, role: "player", socketId: socket.id });
    socket.emit("roll:history", { list: room.rolls || [] });

    // se já existe ficha salva desse socket (reconexão), manda
    if (room.sheets[socket.id]) {
      socket.emit("sheet:load", { ownerSocketId: socket.id, sheet: room.sheets[socket.id], type:"player", id: socket.id });
    }

    emitIndex(id, room);
  });

  socket.on("room:requestIndex", ({ roomId })=>{
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    if (socket.id !== room.masterSocketId) return;
    emitIndex(id, room);
  });

  // Player salva/atualiza ficha (tempo real)
  socket.on("sheet:save", ({ roomId, sheet }) => {
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    if (!room.users[socket.id]) return;

    room.sheets[socket.id] = sheet;

    const sum = extractSummaryFromSheet(sheet);
    // resumo broadcast (atualiza index do mestre)
    if (room.masterSocketId) {
      io.to(room.masterSocketId).emit("sheet:summary", { ownerSocketId: socket.id, ownerName: userName(room, socket.id), ...sum });
      io.to(room.masterSocketId).emit("sheet:push", { ownerSocketId: socket.id, sheet });
      emitIndex(id, room);
    }
  });

  // Mestre pede ficha de um player
  socket.on("master:requestSheet", ({ roomId, ownerSocketId }) => {
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    if (socket.id !== room.masterSocketId) return socket.emit("error:msg", "Apenas o mestre pode ver fichas de outros.");

    const sheet = room.sheets[ownerSocketId];
    if (!sheet) return socket.emit("error:msg", "Esse player ainda não enviou a ficha.");

    socket.emit("sheet:load", { ownerSocketId, sheet, type:"player", id: ownerSocketId });
  });

  // Mestre atualiza ficha do player
  socket.on("master:updateSheet", ({ roomId, ownerSocketId, sheet }) => {
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    if (socket.id !== room.masterSocketId) return socket.emit("error:msg", "Apenas o mestre pode editar fichas de outros.");

    room.sheets[ownerSocketId] = sheet;

    io.to(ownerSocketId).emit("sheet:load", { ownerSocketId, sheet, type:"player", id: ownerSocketId });
    socket.emit("sheet:load", { ownerSocketId, sheet, type:"player", id: ownerSocketId });

    emitIndex(id, room);
  });

  // NPCs (só mestre)
  socket.on("npc:create", ({ roomId, sheet })=>{
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    if (socket.id !== room.masterSocketId) return socket.emit("error:msg", "Só o mestre pode criar NPC.");

    const npcId = "npc_" + Math.random().toString(36).slice(2,10);
    room.npcs[npcId] = sheet || {};
    socket.emit("npc:created", { npcId, sheet: room.npcs[npcId] });
    emitIndex(id, room);
  });

  socket.on("npc:request", ({ roomId, npcId })=>{
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    if (socket.id !== room.masterSocketId) return;
    const sheet = room.npcs[npcId];
    if (!sheet) return socket.emit("error:msg", "NPC não encontrado.");
    socket.emit("npc:load", { npcId, sheet });
  });

  socket.on("npc:update", ({ roomId, npcId, sheet })=>{
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    if (socket.id !== room.masterSocketId) return socket.emit("error:msg", "Só o mestre pode editar NPC.");
    if (!room.npcs[npcId]) return socket.emit("error:msg", "NPC não encontrado.");
    room.npcs[npcId] = sheet;
    socket.emit("npc:load", { npcId, sheet });
    emitIndex(id, room);
  });

  socket.on("npc:delete", ({ roomId, npcId })=>{
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    if (socket.id !== room.masterSocketId) return socket.emit("error:msg", "Só o mestre pode excluir NPC.");
    delete room.npcs[npcId];
    emitIndex(id, room);
  });

  // Rolagens para todos na sala
  socket.on("roll:send", ({ roomId, payload }) => {
    const id = safeRoomId(roomId);
    const room = rooms.get(id);
    if (!room) return;
    const user = room.users[socket.id];
    if (!user) return;

    const entry = {
      roomId: id,
      from: { socketId: socket.id, name: user.name, role: user.role },
      payload,
      at: Date.now()
    };
    room.rolls = room.rolls || [];
    room.rolls.push(entry);
    if (room.rolls.length > 50) room.rolls.shift();

    io.to(id).emit("roll:broadcast", entry);
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.users[socket.id]) {
        const wasMaster = room.masterSocketId === socket.id;
        delete room.users[socket.id];

        if (wasMaster) {
          room.masterSocketId = null;
          io.to(roomId).emit("error:msg", "O mestre desconectou. Sala ficou sem mestre.");
        } else {
          // player saiu: remove sheet index (mantém sheet na memória por enquanto, pode reentrar)
        }

        if (room.masterSocketId) emitIndex(roomId, room);

        if (Object.keys(room.users).length === 0) rooms.delete(roomId);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
