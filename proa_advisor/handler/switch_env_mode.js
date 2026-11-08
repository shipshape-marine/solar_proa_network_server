// Update RUN_MODE in .env
const fs = require("fs");
const dotenv = require("dotenv");
const { RUN_MODES } = require("./run_mode");
dotenv.config();

function switchMode(mode) {
    if (!RUN_MODES.includes(mode)) {
        throw new Error(`Invalid mode "${mode}". Must be one of: ${RUN_MODES.join(", ")}`);
    }
    // Update the .env file
    const envFilePath = ".env";
    const envConfig = dotenv.parse(fs.readFileSync(envFilePath));
    envConfig.RUN_MODE = mode;
    const newEnvContent = Object.entries(envConfig)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
    fs.writeFileSync(envFilePath, newEnvContent);
    // Update the process.env variable
    process.env.RUN_MODE = mode;
}

module.exports = {
    switchMode
};