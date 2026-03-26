const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// TURN server config endpoint
app.get("/ice-config", (req, res) => {
  res.json({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject"
      },
      {
        urls: "turn:openrelay.metered.ca:443",
        username: "openrelayproject",
        credential: "openrelayproject"
      },
      {
        urls: "turn:openrelay.metered.ca:443?transport=tcp",
        username: "openrelayproject",
        credential: "openrelayproject"
      }
    ]
  });
});

// Routes
app.get("/agent", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "agent.html"));
});

app.get("/customer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customer.html"));
});

// Track connected clients
let agentSocketId = null;
let customerSocketId = null;
let callState = "idle"; // idle | ai-active | human-active

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // --- Registration ---
  socket.on("register-agent", () => {
    agentSocketId = socket.id;
    console.log("Agent registered:", socket.id);
    socket.emit("registered", { role: "agent" });
    // Notify agent of current call state
    socket.emit("call-state", { state: callState });
  });

  socket.on("register-customer", () => {
    customerSocketId = socket.id;
    console.log("Customer registered:", socket.id);
    socket.emit("registered", { role: "customer" });
  });

  // --- WebRTC Signaling ---
  socket.on("offer", (data) => {
    const target = data.target === "agent" ? agentSocketId : customerSocketId;
    if (target) io.to(target).emit("offer", { ...data, from: socket.id });
  });

  socket.on("answer", (data) => {
    const target = data.target === "agent" ? agentSocketId : customerSocketId;
    if (target) io.to(target).emit("answer", { ...data, from: socket.id });
  });

  socket.on("ice-candidate", (data) => {
    const target = data.target === "agent" ? agentSocketId : customerSocketId;
    if (target) io.to(target).emit("ice-candidate", { ...data, from: socket.id });
  });

  // --- Call Control ---
  socket.on("start-call", () => {
    callState = "ai-active";
    io.emit("call-state", { state: callState });
    console.log("Call started - AI active");
  });

  socket.on("trigger-handoff", (data) => {
    callState = "human-active";
    io.emit("call-state", { state: callState });
    io.emit("handoff-triggered", { reason: data.reason || "Manual handoff" });
    console.log("Handoff triggered:", data.reason);
  });

  socket.on("end-call", () => {
    callState = "idle";
    io.emit("call-state", { state: callState });
    io.emit("call-ended");
    console.log("Call ended");
  });

  // --- Chat messages (for AI transcript simulation) ---
  socket.on("chat-message", (data) => {
    io.emit("chat-message", { ...data, from: socket.id });
  });

  socket.on("disconnect", () => {
    if (socket.id === agentSocketId) agentSocketId = null;
    if (socket.id === customerSocketId) customerSocketId = null;
    console.log("Disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Agent: http://localhost:${PORT}/agent`);
  console.log(`Customer: http://localhost:${PORT}/customer`);
});
