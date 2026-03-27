const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── ICE config ──────────────────────────────────────────────
app.get("/ice-config", (req, res) => {
  const KEY = process.env.METERED_API_KEY || "";
  if (KEY) {
    fetch(`https://loanassist.metered.live/api/v1/turn/credentials?apiKey=${KEY}`)
      .then(r => r.json()).then(iceServers => res.json({ iceServers }))
      .catch(() => res.json({ iceServers: fallbackIce() }));
  } else { res.json({ iceServers: fallbackIce() }); }
});
function fallbackIce() {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: ["turn:openrelay.metered.ca:80","turn:openrelay.metered.ca:443","turn:openrelay.metered.ca:443?transport=tcp"], username:"openrelayproject", credential:"openrelayproject" }
  ];
}

// ── OpenAI proxies ───────────────────────────────────────────
app.post("/api/transcribe", async (req, res) => {
  const KEY = process.env.OPENAI_API_KEY;
  if (!KEY) return res.status(500).json({ error: { message: "No OpenAI key" } });
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    try {
      const body = Buffer.concat(chunks);
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": req.headers["content-type"] },
        body
      });
      res.json(await r.json());
    } catch(e) { res.status(500).json({ error: { message: e.message } }); }
  });
});

app.post("/api/chat", async (req, res) => {
  const KEY = process.env.OPENAI_API_KEY;
  if (!KEY) return res.status(500).json({ error: "No OpenAI key" });
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/ds-engine", (req, res) => {
  setTimeout(() => res.json({ channel: "AMBER", reason: "Banking verification required" }), 1200);
});

// ── Routes ───────────────────────────────────────────────────
app.get("/agent", (req, res) => res.sendFile(path.join(__dirname, "public", "agent.html")));
app.get("/customer", (req, res) => res.sendFile(path.join(__dirname, "public", "customer.html")));

// ── State ────────────────────────────────────────────────────
let agentSocketId = null;

// Pre-loaded customers + dynamically added ones
const customerList = [
  { id: "cust_001", name: "Rahul Sharma",   phone: "+91 98765 43210", city: "Delhi" },
  { id: "cust_002", name: "Priya Mehta",    phone: "+91 87654 32109", city: "Mumbai" },
  { id: "cust_003", name: "Arjun Verma",    phone: "+91 76543 21098", city: "Bangalore" },
  { id: "cust_004", name: "Sneha Kapoor",   phone: "+91 65432 10987", city: "Hyderabad" },
];

// customerId -> { socketId, state, details, queuedAt }
const customerSessions = {};
// queue of customerIds waiting for human
const queue = [];

// REST: get customer list
app.get("/api/customers", (req, res) => res.json(customerList));

// REST: add a new customer
app.post("/api/customers", (req, res) => {
  const { name, phone, city } = req.body;
  const id = "cust_" + Date.now();
  customerList.push({ id, name, phone: phone||"", city: city||"" });
  res.json({ id, name, phone, city });
  if (agentSocketId) io.to(agentSocketId).emit("customer-list", customerList);
});

// ── Socket.io ────────────────────────────────────────────────
io.on("connection", (socket) => {

  // ── Agent ──
  socket.on("register-agent", () => {
    agentSocketId = socket.id;
    socket.emit("customer-list", customerList);
    socket.emit("queue-update", { queue: queueSnapshot() });
  });

  // ── Customer ──
  socket.on("register-customer", ({ customerId }) => {
    customerSessions[customerId] = { socketId: socket.id, state: "waiting", details: {}, customerId };
    socket.customerId = customerId;
    console.log("Customer registered:", customerId, socket.id);
    // Tell agent this customer is online
    if (agentSocketId) io.to(agentSocketId).emit("customer-online", { customerId });
  });

  // ── Agent initiates call to customer ──
  socket.on("initiate-call", ({ customerId }) => {
    const session = customerSessions[customerId];
    if (!session) return socket.emit("call-error", { msg: "Customer not online" });
    session.state = "ringing";
    io.to(session.socketId).emit("incoming-call", { customerId });
    socket.emit("call-ringing", { customerId });
    console.log("Call initiated to:", customerId);
  });

  // ── Customer answers ──
  socket.on("answer-call", ({ customerId }) => {
    const session = customerSessions[customerId];
    if (!session) return;
    session.state = "ai-active";
    socket.emit("call-state", { state: "ai-active" });
    if (agentSocketId) io.to(agentSocketId).emit("call-answered", { customerId });
    console.log("Call answered:", customerId);
  });

  // ── Customer declines ──
  socket.on("decline-call", ({ customerId }) => {
    const session = customerSessions[customerId];
    if (session) session.state = "waiting";
    if (agentSocketId) io.to(agentSocketId).emit("call-declined", { customerId });
  });

  // ── WebRTC signaling ──
  socket.on("offer", ({ target, sdp }) => {
    const session = customerSessions[target];
    if (session) io.to(session.socketId).emit("offer", { sdp, from: socket.id });
    else if (target === "agent" && agentSocketId) io.to(agentSocketId).emit("offer", { sdp, from: socket.id, customerId: socket.customerId });
  });

  socket.on("answer", ({ target, sdp }) => {
    const session = customerSessions[target];
    if (session) io.to(session.socketId).emit("answer", { sdp });
    else if (target === "agent" && agentSocketId) io.to(agentSocketId).emit("answer", { sdp });
  });

  socket.on("ice-candidate", ({ target, candidate }) => {
    const session = customerSessions[target];
    if (session) io.to(session.socketId).emit("ice-candidate", { candidate });
    else if (target === "agent" && agentSocketId) io.to(agentSocketId).emit("ice-candidate", { candidate });
  });

  // ── Details collected by AI ──
  socket.on("details-collected", ({ customerId, details }) => {
    if (customerSessions[customerId]) customerSessions[customerId].details = details;
  });

  // ── DS engine → Amber → add to queue ──
  socket.on("add-to-queue", ({ customerId, details }) => {
    if (!queue.includes(customerId)) {
      queue.push(customerId);
      if (customerSessions[customerId]) {
        customerSessions[customerId].state = "queued";
        customerSessions[customerId].details = details || customerSessions[customerId].details;
        customerSessions[customerId].queuedAt = Date.now();
      }
      const pos = queue.indexOf(customerId) + 1;
      io.to(socket.id).emit("queued", { position: pos });
      if (agentSocketId) io.to(agentSocketId).emit("queue-update", { queue: queueSnapshot() });
    }
  });

  // ── Agent picks up from queue ──
  socket.on("pickup-lead", ({ customerId }) => {
    const idx = queue.indexOf(customerId);
    if (idx === -1) return;
    queue.splice(idx, 1);
    const session = customerSessions[customerId];
    if (!session) return;
    session.state = "human-active";
    io.to(session.socketId).emit("call-state", { state: "human-active" });
    io.to(session.socketId).emit("handoff-triggered", { reason: "Banking verification required" });
    socket.emit("connect-to-customer", { customerId, socketId: session.socketId, details: session.details });
    socket.emit("queue-update", { queue: queueSnapshot() });
    // Trigger WebRTC: tell customer agent is ready
    io.to(session.socketId).emit("agent-ready");
  });

  // ── Agent ready for WebRTC ──
  socket.on("agent-ready", ({ customerId }) => {
    const session = customerSessions[customerId];
    if (session) io.to(session.socketId).emit("agent-ready");
  });

  // ── Chat ──
  socket.on("chat-message", ({ customerId, text, role }) => {
    const session = customerSessions[customerId];
    if (session) io.to(session.socketId).emit("chat-message", { text, role });
    if (agentSocketId) io.to(agentSocketId).emit("chat-message", { text, role, customerId });
  });

  // ── End call ──
  socket.on("end-call", ({ customerId }) => {
    const cid = customerId || socket.customerId;
    const session = customerSessions[cid];
    if (session) { io.to(session.socketId).emit("call-ended"); session.state = "waiting"; }
    const qi = queue.indexOf(cid);
    if (qi !== -1) queue.splice(qi, 1);
    if (agentSocketId) io.to(agentSocketId).emit("queue-update", { queue: queueSnapshot() });
  });

  socket.on("disconnect", () => {
    if (socket.id === agentSocketId) agentSocketId = null;
    if (socket.customerId) {
      const qi = queue.indexOf(socket.customerId);
      if (qi !== -1) queue.splice(qi, 1);
      delete customerSessions[socket.customerId];
      if (agentSocketId) io.to(agentSocketId).emit("customer-offline", { customerId: socket.customerId });
      if (agentSocketId) io.to(agentSocketId).emit("queue-update", { queue: queueSnapshot() });
    }
  });
});

function queueSnapshot() {
  return queue.map((cid, i) => {
    const s = customerSessions[cid] || {};
    const c = customerList.find(x => x.id === cid) || {};
    return { customerId: cid, position: i+1, name: c.name||"Unknown", details: s.details||{}, queuedAt: s.queuedAt||Date.now() };
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
