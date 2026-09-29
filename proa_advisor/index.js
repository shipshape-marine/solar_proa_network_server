// Modify how the node server starts but using a child process instead of directly starting
// Can include an on close with a signal to indicate if restart is required


const express = require("express");
const jwt = require("jsonwebtoken");
const bodyParser = require("body-parser");
const process = require("node:process");
const dotenv = require("dotenv");

const path = require("path");
dotenv.config({ path: path.join(__dirname, ".env") });
const app = express();
const port = 4000;
const cors = require("cors");
const mapTilesPath = path.resolve(__dirname, process.env.MAP_TILES_DIR ?? "map-tiles");

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use("/map-tiles", express.static(mapTilesPath, {
    maxAge: "1d",
    etag: true,
    fallthrough: true,
}));
app.use(express.static(path.join(__dirname, 'public')));
const { add_client, get_clients, remove_client } = require("./handler/client_transmission");
const { getCurrentRunId } = require("./lib/Kalman Filter/kalman_filter");
const { populateInitalChartData } = require('./model/power_management_db');
const { getIMUDataByRunId } = require('./model/imu_db');
const { getStrainDataByRunId } = require('./model/strain_db');
const { getGPSDataByRunId } = require('./model/gps_db');
// Same pattern as getCurrentRunId for power: the run_id is owned by the writer
// and shared, not re-derived per request.
const { getCurrentIMURunId } = require("./handler/serial_reader/components/imu_data_parser");
const { getCurrentStrainRunId } = require("./handler/serial_reader/components/strain_data_parser");
const { getCurrentGPSRunId } = require("./handler/serial_reader/components/gps_data_parser");
const { requestCommand } = require('./handler/serial_writer/serial_writer');
const { startBackend } = require("./server");
const { connectToWifi } = require("./handler/internet_connection/wifi_manager")
const {  } = require("./handler/terminal_socket/ws");
const { hasInternet } = require("./handler/database_update/connectivity");
const { switchMode } = require("./handler/switch_env_mode");
const { closeAllConnections } = require("./handler/terminal_socket/ws");
const { updateRepo } = require("./handler/repository/simple_git");
const { streamSOCSensorCsvByRun, streamSensorCsvByRun, normalizeRowId, normalizeRunId, normalizeSensorKey, getSOCSensorRunSummaries, getRunSummaries, getSensorLabel, DownloadInProgressError } = require("./handler/database_download");
const { getMapConfig } = require("./handler/map_config");

const nodeMacAddresses = Object.freeze({
    imu: "88:56:A6:6C:F0:04",
    strain: "D4:E9:F4:CA:F0:B0",
});


// Simple admin authentication for accessing dev panel as it is not a full-fledged web application. 
const users = [
    { username: process.env.DEFAULT_ADMIN_USERNAME, password: process.env.DEFAULT_ADMIN_PASSWORD }
]

app.post("/admin_login", (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username.toString().trim() && u.password === password.toString().trim());

    if (user) {
        const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.status(200).json({ token });
    } else {
        res.status(401).json({ message: "Invalid credentials" });
    }
});

const middlewareAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ message: "No token provided" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid token" });
    }
};


// ------------------- //
// PUBLIC ROUTES
// ------------------- //

app.get("/map_config", (req, res) => {
    try {
        res.json(getMapConfig());
    } catch (error) {
        console.error("Error loading map configuration:", error);
        res.status(500).json({ message: "Map configuration is invalid." });
    }
});

// Data stream format => event: <event_type>\ndata: <data_as_json_string>\n\n
// Keep only one connection open to a client at a time
app.get("/data_stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    add_client(res);
    res.write(": connected\n\n");

    req.on("close", () => {
        remove_client(res);
    });
})

app.get("/initial_power_data", async (req, res) => {
    try {
        const runId = await getCurrentRunId();
        const initialData = await populateInitalChartData(runId);
        res.json(initialData.reverse());
    } catch (error) {
        console.error("Error fetching initial data:", error);
        res.status(500).send("Error fetching initial data");
    }
});

app.get("/initial_imu_data", async (req, res) => {
    try {
        const run_id = await getCurrentIMURunId();
        const data = await getIMUDataByRunId(run_id, 1000);
        res.json(data);
    } catch (error) {
        console.error("Error fetching initial IMU data:", error);
        res.status(500).send("Error fetching initial IMU data");
    }
});

app.get("/initial_strain_data", async (req, res) => {
    try {
        const run_id = await getCurrentStrainRunId();
        const data = await getStrainDataByRunId(run_id, 2000);
        res.json(data);
    } catch (error) {
        console.error("Error fetching initial strain data:", error);
        res.status(500).send("Error fetching initial strain data");
    }
});

app.get("/initial_gps_data", async (req, res) => {
    try {
        const run_id = await getCurrentGPSRunId();
        const data = await getGPSDataByRunId(run_id, 2000);
        res.json(data);
    } catch (error) {
        console.error("Error fetching initial GPS data:", error);
        res.status(500).send("Error fetching initial GPS data");
    }
});

app.post("/send_command", middlewareAuth, (req, res) => {
    const { macAddress, command } = req.body;
    if (!macAddress || !command) {
        return res.status(400).json({ message: "macAddress and command are required" });
    }
    const sent = requestCommand(macAddress, command);
    if (sent) {
        res.json({ ok: true, message: `Command '${command}' sent to ${macAddress}` });
    } else {
        res.status(503).json({ ok: false, message: "No serial port connected" });
    }
});

app.get("/get_mac_address", middlewareAuth, (req, res) => {
    const node = req.query.node;
    if (typeof node !== "string" || !Object.hasOwn(nodeMacAddresses, node)) {
        return res.status(400).json({ message: "node must be one of: imu, strain" });
    }
    res.json({ macAddress: nodeMacAddresses[node] });
});

app.get("/has_internet", (req, res) => {
    hasInternet().then((internet) => {
        res.json({ hasInternet: internet });
    }).catch((error) => {
        res.status(500).json({ hasInternet: false, error: "Error checking internet connectivity" });
    });
});

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});


/* Captive portal setup */
// Android
app.get("/generate_204", (req, res) => {
    res.redirect("/");
});

// Android newer versions
app.get("/gen_204", (req, res) => {
    res.redirect("/");
});

// Apple iOS/macOS
app.get("/hotspot-detect.html", (req, res) => {
    res.redirect("/");
});

// Windows
app.get("/ncsi.txt", (req, res) => {
    res.redirect("/");
});

// ------------------- //
// PROTECTED ROUTES
// ------------------- //
app.post("/connect_wifi", middlewareAuth, async (req, res) => {
    const { ssid, password } = req.body;
    if (!ssid || !password) {
        return res.status(400).json({ message: "SSID and password are required" });
    }
    const success = await connectToWifi(ssid, password);
    if (success.success) {
        res.status(200).json({ message: success.message });
    } else {
        res.status(500).json({ message: success.message });
    }
});

app.get("/get_curr_mode", middlewareAuth, (req, res) => {
    const mode = process.env.IS_TEST_RUN === "true" ? "test" : "normal";
    res.status(200).json({ "mode": mode });
});

app.get("/set_mode_and_restart", middlewareAuth, (req, res) => {
    const { mode } = req.query;
    switchMode(mode);
    if (process.send) {
        closeAllConnections();
        process.send({
            action: "restart"
        });
    }
    res.status(200).json({ message: `Switched mode to ${process.env.IS_TEST_RUN === "true" ? "test" : "normal"}` });
});

app.get("/rebuild_and_restart", middlewareAuth, (req, res) => {
    console.log("Rebuild and restart requested.");
    if (process.send) {
        closeAllConnections();
        process.send({
            action: "rebuild"
        });
    }
    res.status(200).json({ message: "Rebuild initiated. Server will restart after rebuild." });
});

app.get("/stop_server", middlewareAuth, (req, res) => {
    if (process.send) {
        closeAllConnections();
        process.send({
            action: "stop"
        });
    }
    res.status(200).json({ message: "Server is stopping..." });
});

app.get("/update_repo", middlewareAuth, (req, res) => {
    updateRepo().then((update_result) => {
        if (update_result.updated) {
            res.status(200).json({ message: update_result.message });
        } else {
            res.status(500).json({ message: update_result.message });
        }
    }).catch((error) => {
        res.status(500).json({ message: "Error updating repository", error: error.message });
    });
});

app.get("/download_socsensor_current_run", middlewareAuth, async (req, res) => {
    try {
        const rowId = normalizeRowId(req.query.rowid ?? req.query.start_rowid);
        const runId = await getCurrentRunId();
        await streamSOCSensorCsvByRun(req, res, runId, rowId);
    } catch (error) {
        if (error instanceof DownloadInProgressError) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        if (error?.message === "rowid must be a non-negative integer.") {
            return res.status(400).json({ message: error.message });
        }
        if (!res.headersSent) {
            return res.status(500).json({ message: "Failed to download SOCSensor data." });
        }
        if (!res.writableEnded) {
            res.end();
        }
    }
});

app.get("/socsensor_runs", middlewareAuth, async (req, res) => {
    try {
        const runs = await getSOCSensorRunSummaries();
        res.status(200).json({ runs });
    } catch (error) {
        res.status(500).json({ message: "Failed to load SOCSensor run list." });
    }
});

app.get("/download_socsensor", middlewareAuth, async (req, res) => {
    try {
        const runId = normalizeRunId(req.query.run_id);
        const rowId = normalizeRowId(req.query.rowid ?? req.query.start_rowid);
        await streamSOCSensorCsvByRun(req, res, runId, rowId);
    } catch (error) {
        if (error instanceof DownloadInProgressError) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        if (error?.message === "rowid must be a non-negative integer." || error?.message === "run_id must be a positive integer.") {
            return res.status(400).json({ message: error.message });
        }
        if (!res.headersSent) {
            return res.status(500).json({ message: "Failed to download SOCSensor data." });
        }
        if (!res.writableEnded) {
            res.end();
        }
    }
});

// Generic per-sensor equivalents of the two routes above. Each sensor stream has
// its own run_id counter, so the type has to be part of every request.
app.get("/sensor_runs", middlewareAuth, async (req, res) => {
    try {
        const sensorKey = normalizeSensorKey(req.query.type);
        const runs = await getRunSummaries(sensorKey);
        res.status(200).json({ type: sensorKey, label: getSensorLabel(sensorKey), runs });
    } catch (error) {
        if (error?.message?.startsWith("sensor type must be one of")) {
            return res.status(400).json({ message: error.message });
        }
        res.status(500).json({ message: "Failed to load sensor run list." });
    }
});

app.get("/download_sensor", middlewareAuth, async (req, res) => {
    let sensorLabel = "sensor";
    try {
        const sensorKey = normalizeSensorKey(req.query.type);
        sensorLabel = getSensorLabel(sensorKey);
        const runId = normalizeRunId(req.query.run_id);
        const rowId = normalizeRowId(req.query.rowid ?? req.query.start_rowid);
        await streamSensorCsvByRun(req, res, sensorKey, runId, rowId);
    } catch (error) {
        if (error instanceof DownloadInProgressError) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        if (error?.message === "rowid must be a non-negative integer."
            || error?.message === "run_id must be a positive integer."
            || error?.message?.startsWith("sensor type must be one of")) {
            return res.status(400).json({ message: error.message });
        }
        if (!res.headersSent) {
            return res.status(500).json({ message: `Failed to download ${sensorLabel} data.` });
        }
        if (!res.writableEnded) {
            res.end();
        }
    }
});

if (require.main === module) {
    startBackend();
    app.listen(port, "0.0.0.0", () => {
        console.log(`Listening on port ${port}`);
        console.log(`Access the application at http://localhost:${port}`);
    });
}

module.exports = { app };
