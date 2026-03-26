const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// TURN server config
app.get("/ice-config", (req, res) => {
  const METERED_API_KEY = process.env.METERED_API_KEY || "";
  if (METERED_API_KEY) {
    fetch(`https://loanassist.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`)
      .then(r => r.json())
      .then(iceServers => res.json({ iceServers }))
      .catch(() => res.json({ iceServers: getFallbackIce() }));
  } else {
    res.json({ iceServers: getFallbackIce() });
  }
});

function getFallbackIce() {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ];
}

// OpenAI proxy — keeps API key server-side
app.post("/api/transcribe", async (req, res) => {
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: { message: "No OpenAI API key configured" } });

    // Buffer the raw multipart body and forward directly to Whisper
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks);
        console.log("Transcribe request - size:", body.length, "content-type:", req.headers["content-type"]);
        const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": req.headers["content-type"]
          },
          body
        });
        const data = await response.json();
        console.log("Whisper response:", JSON.stringify(data).substring(0, 200));
        res.json(data);
      } catch(e) {
        console.error("Whisper fetch error:", e.message);
        res.status(500).json({ error: { message: e.message } });
      }
    });
  } catch (e) {
    console.error("Transcribe error:", e.message);
    res.status(500).json({ error: { message: e.message } });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "No OpenAI key" });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mock DS engine — always returns Amber
app.post("/api/ds-engine", (req, res) => {
  const { details } = req.body;
  console.log("DS Engine called with:", details);
  // Always Amber for demo
  setTimeout(() => res.json({ channel: "AMBER", reason: "Banking verification required" }), 1500);
});

// Routes
app.get("/agent", (req, res) => res.sendFile(path.join(__dirname, "public", "agent.html")));
app.get("/customer", (req, res) => res.sendFile(path.join(__dirname, "public", "customer.html")));

// State
let agentSocketId = null;
const customers = {}; // socketId -> { details, state, queuePosition }
const queue = []; // ordered list of socketIds waiting for human

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("register-agent", () => {
    agentSocketId = socket.id;
    socket.emit("registered", { role: "agent" });
    socket.emit("queue-update", { queue: getQueueData() });
    console.log("Agent registered");
  });

  socket.on("register-customer", () => {
    customers[socket.id] = { state: "idle", details: {} };
    socket.emit("registered", { role: "customer" });
    console.log("Customer registered:", socket.id);
  });

  // WebRTC signaling — route to correct target
  socket.on("offer", (data) => {
    const target = data.target === "agent" ? agentSocketId : data.target; // target can be socketId too
    if (target) io.to(target).emit("offer", { ...data, from: socket.id });
  });

  socket.on("answer", (data) => {
    const target = data.target === "agent" ? agentSocketId : data.target;
    if (target) io.to(target).emit("answer", { ...data, from: socket.id });
  });

  socket.on("ice-candidate", (data) => {
    const target = data.target === "agent" ? agentSocketId : data.target;
    if (target) io.to(target).emit("ice-candidate", { ...data, from: socket.id });
  });

  // Customer started call with AI
  socket.on("start-call", () => {
    if (customers[socket.id]) customers[socket.id].state = "ai-active";
    socket.emit("call-state", { state: "ai-active" });
    console.log("AI call started:", socket.id);
  });

  // Customer details collected by AI
  socket.on("details-collected", (details) => {
    if (customers[socket.id]) customers[socket.id].details = details;
    console.log("Details collected for:", socket.id, details);
  });

  // DS engine returned Amber — add to queue
  socket.on("add-to-queue", (data) => {
    if (!queue.includes(socket.id)) {
      queue.push(socket.id);
      if (customers[socket.id]) {
        customers[socket.id].state = "queued";
        customers[socket.id].details = data.details || customers[socket.id].details;
        customers[socket.id].queuedAt = Date.now();
      }
      socket.emit("queued", { position: queue.length });
      if (agentSocketId) io.to(agentSocketId).emit("queue-update", { queue: getQueueData() });
      console.log("Added to queue:", socket.id, "Queue length:", queue.length);
    }
  });

  // Agent picks a customer from queue
  socket.on("pickup-lead", ({ customerSocketId }) => {
    const idx = queue.indexOf(customerSocketId);
    if (idx !== -1) {
      queue.splice(idx, 1);
      if (customers[customerSocketId]) customers[customerSocketId].state = "human-active";
      // Tell customer they're being connected to human
      io.to(customerSocketId).emit("handoff-triggered", { reason: "Banking verification required" });
      io.to(customerSocketId).emit("call-state", { state: "human-active" });
      // Tell agent the customer details + signal agent-ready for WebRTC
      socket.emit("connect-to-customer", {
        customerSocketId,
        details: customers[customerSocketId]?.details || {}
      });
      // Update queue for agent
      socket.emit("queue-update", { queue: getQueueData() });
      console.log("Agent picking up:", customerSocketId);
    }
  });

  // Agent signals ready for WebRTC after pickup
  socket.on("agent-ready", ({ customerSocketId: cId }) => {
    io.to(cId).emit("agent-ready");
  });

  socket.on("trigger-handoff", (data) => {
    const cId = data.customerSocketId || Object.keys(customers).find(id => customers[id].state === "ai-active");
    if (cId) {
      io.to(cId).emit("handoff-triggered", { reason: data.reason });
      io.to(cId).emit("call-state", { state: "human-active" });
    }
  });

  socket.on("end-call", ({ customerSocketId: cId } = {}) => {
    const target = cId || socket.id;
    io.to(target).emit("call-ended");
    if (customers[target]) customers[target].state = "idle";
    const qi = queue.indexOf(target);
    if (qi !== -1) queue.splice(qi, 1);
    if (agentSocketId) io.to(agentSocketId).emit("queue-update", { queue: getQueueData() });
    console.log("Call ended for:", target);
  });

  socket.on("chat-message", (data) => {
    const target = data.target || (agentSocketId === socket.id ? data.customerSocketId : agentSocketId);
    if (target) io.to(target).emit("chat-message", { ...data, from: socket.id });
  });

  socket.on("disconnect", () => {
    if (socket.id === agentSocketId) agentSocketId = null;
    const qi = queue.indexOf(socket.id);
    if (qi !== -1) queue.splice(qi, 1);
    delete customers[socket.id];
    if (agentSocketId) io.to(agentSocketId).emit("queue-update", { queue: getQueueData() });
    console.log("Disconnected:", socket.id);
  });
});

function getQueueData() {
  return queue.map((id, idx) => ({
    socketId: id,
    position: idx + 1,
    details: customers[id]?.details || {},
    queuedAt: customers[id]?.queuedAt || Date.now()
  }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
