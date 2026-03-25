# LoanAssist – AI to Human Agent Handoff Demo

## What this does
A WebRTC-based demo showing seamless AI-to-human agent handoff during a loan application call.

- **Agent Dashboard** (`/agent`) — You control the call, trigger handoffs, monitor transcript
- **Customer View** (`/customer`) — Share this URL with your friend (the mock customer)

---

## Local Setup

```bash
npm install
npm start
```

Open http://localhost:3000

---

## Deploy to Render (Free)

1. Push this folder to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment**: Node
5. Deploy — you get a free public URL like `https://loanassist-demo.onrender.com`

Share:
- `/agent` → You (open this on your laptop)
- `/customer` → Your friend (send them the link on their phone/laptop)

---

## How to Demo

1. Open `/agent` on your screen
2. Send `/customer` link to your friend
3. Your friend clicks **"Join Call"** — this starts the call
4. Click **"Connect My Audio"** on your agent dashboard
5. Now you're both on a live WebRTC call
6. Use the **Trigger Handoff** buttons to simulate AI failure scenarios:
   - Language barrier
   - File upload requested
   - Complex query
   - Customer requested human
7. Click **"Take Over as Human Agent"** — the UI updates for both sides
8. You can now talk directly as the human agent

---

## Handoff Scenarios Included
- 🌐 Language barrier
- 📎 File upload request
- 🧠 Complex query beyond AI
- 🙋 Customer requested human agent
