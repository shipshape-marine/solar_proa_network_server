const WebSocket = require("ws");
const pty = require("node-pty");
const jwt = require("jsonwebtoken");

const os = require("os");

function getShell() {
    switch (os.platform()) {
        case "win32":
            return "powershell.exe";

        case "darwin":
            return process.env.SHELL || "/bin/zsh";

        case "linux":
            return process.env.SHELL || "/bin/bash";

        default:
            throw new Error("Unsupported platform");
    }
}

const wss = process.env.NODE_ENV === "test"
    ? null
    : new WebSocket.Server({
        port: 3001,
    });

wss?.on("connection", (ws, req) => {
    // localhost:3001?token=YOUR_JWT
    const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
    try {
        const decoded = jwt.verify(
            query.toString().slice(6),
            process.env.JWT_SECRET,
        );
        ws.user = decoded;
    } catch (err) {
        ws.close(1008, "Invalid token");
        return;
    }

    const ptyProcess = pty.spawn(getShell(), [], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: process.env.HOME,
        env: process.env,
    });

    ptyProcess.onData((data) => {
        ws.send(data);
    });

    ws.on("message", (msg) => {
        ptyProcess.write(msg.toString());
    });

    ws.on("close", () => {
        ptyProcess.kill();
    });
});

function closeAllConnections() {
    if (!wss) return;
    wss.clients.forEach((client) => {
        client.close(1001, "Server shutting down");
    });
}

if (wss) {
    console.log("WebSocket server running on ws://localhost:3001");
}

module.exports = {
    closeAllConnections,
};
