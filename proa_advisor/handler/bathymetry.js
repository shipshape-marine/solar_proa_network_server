const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BATHYMETRY_DIR = path.resolve(__dirname, "../model/bathymetry");
const DEFAULT_OVERLAY_OPACITY = 0.45;

let cachedDataset;
let loadAttempted = false;
const emittedWarnings = new Set();

function warnOnce(message) {
    if (!emittedWarnings.has(message)) {
        emittedWarnings.add(message);
        console.warn(message);
    }
}

function discoverBathymetryFiles(directory = DEFAULT_BATHYMETRY_DIR) {
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        warnOnce(`Bathymetry data directory could not be read: ${directory} (${error.message})`);
        return null;
    }

    const asciiFiles = new Map();
    const imageFiles = new Map();

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const asciiMatch = entry.name.match(/^(.+)_ascii\.asc$/i);
        if (asciiMatch) {
            asciiFiles.set(asciiMatch[1], path.join(directory, entry.name));
            continue;
        }

        const imageMatch = entry.name.match(/^(.+)_png_cm\.png$/i);
        if (imageMatch) {
            imageFiles.set(imageMatch[1], path.join(directory, entry.name));
        }
    }

    const prefixes = [...new Set([...asciiFiles.keys(), ...imageFiles.keys()])].sort();
    const completePrefixes = prefixes.filter((prefix) => asciiFiles.has(prefix) && imageFiles.has(prefix));
    if (completePrefixes.length === 0) {
        const missingPart = asciiFiles.size > 0 || imageFiles.size > 0
            ? "No matching _ascii.asc and _png_cm.png pair was found."
            : "No files ending in _ascii.asc or _png_cm.png were found.";
        warnOnce(`Bathymetry data unavailable in ${directory}: ${missingPart}`);
        return null;
    }

    if (completePrefixes.length > 1) {
        warnOnce(`Multiple bathymetry datasets found in ${directory}; using ${completePrefixes[0]}.`);
    }

    const prefix = completePrefixes[0];
    return {
        prefix,
        asciiPath: asciiFiles.get(prefix),
        imagePath: imageFiles.get(prefix),
    };
}

function parseAsciiGrid(asciiPath) {
    const content = fs.readFileSync(asciiPath, "utf8");
    const lines = content.split(/\r?\n/);
    const header = new Map();
    let dataStart = 0;

    for (let index = 0; index < lines.length && header.size < 6; index += 1) {
        const match = lines[index].trim().match(/^([A-Za-z_]+)\s+([-+]?\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?)$/);
        if (!match) {
            break;
        }
        header.set(match[1].toLowerCase(), Number(match[2]));
        dataStart = index + 1;
    }

    const ncols = header.get("ncols");
    const nrows = header.get("nrows");
    const xllcorner = header.get("xllcorner");
    const yllcorner = header.get("yllcorner");
    const cellsize = header.get("cellsize");
    const nodataValue = header.get("nodata_value");

    if (!Number.isInteger(ncols) || ncols <= 0
        || !Number.isInteger(nrows) || nrows <= 0
        || !Number.isFinite(xllcorner) || !Number.isFinite(yllcorner)
        || !Number.isFinite(cellsize) || cellsize <= 0
        || !Number.isFinite(nodataValue)) {
        throw new Error(`Bathymetry ASCII header is invalid: ${asciiPath}`);
    }

    const valueTokens = lines.slice(dataStart).join(" ").trim().split(/\s+/).filter(Boolean);
    const expectedValues = ncols * nrows;
    if (valueTokens.length < expectedValues) {
        throw new Error(`Bathymetry ASCII grid has ${valueTokens.length} values; expected ${expectedValues}.`);
    }

    const values = new Float64Array(expectedValues);
    for (let index = 0; index < expectedValues; index += 1) {
        const value = Number(valueTokens[index]);
        if (!Number.isFinite(value)) {
            throw new Error(`Bathymetry ASCII grid contains an invalid value at index ${index}.`);
        }
        values[index] = value;
    }

    return {
        ncols,
        nrows,
        xllcorner,
        yllcorner,
        cellsize,
        nodataValue,
        values,
        bounds: {
            south: yllcorner,
            west: xllcorner,
            north: yllcorner + nrows * cellsize,
            east: xllcorner + ncols * cellsize,
        },
    };
}

function loadBathymetryDataset(directory = DEFAULT_BATHYMETRY_DIR) {
    if (loadAttempted && directory === DEFAULT_BATHYMETRY_DIR) {
        return cachedDataset;
    }

    const files = discoverBathymetryFiles(directory);
    if (!files) {
        if (directory === DEFAULT_BATHYMETRY_DIR) {
            loadAttempted = true;
            cachedDataset = null;
        }
        return null;
    }

    try {
        const grid = parseAsciiGrid(files.asciiPath);
        const dataset = {
            ...files,
            grid,
        };
        if (directory === DEFAULT_BATHYMETRY_DIR) {
            loadAttempted = true;
            cachedDataset = dataset;
        }
        return dataset;
    } catch (error) {
        warnOnce(`Bathymetry data unavailable: ${error.message}`);
        if (directory === DEFAULT_BATHYMETRY_DIR) {
            loadAttempted = true;
            cachedDataset = null;
        }
        return null;
    }
}

function unavailableConfig() {
    return {
        available: false,
        warning: "Bathymetry data is unavailable; the bathymetry layer is disabled.",
    };
}

function getBathymetryConfig() {
    const dataset = loadBathymetryDataset();
    if (!dataset) {
        return unavailableConfig();
    }

    const { grid } = dataset;
    return {
        available: true,
        dataset: dataset.prefix,
        imageUrl: "/bathymetry/image",
        opacity: DEFAULT_OVERLAY_OPACITY,
        bounds: [
            [grid.bounds.south, grid.bounds.west],
            [grid.bounds.north, grid.bounds.east],
        ],
        grid: {
            ncols: grid.ncols,
            nrows: grid.nrows,
            cellsize: grid.cellsize,
            nodataValue: grid.nodataValue,
        },
    };
}

function getBathymetryImagePath() {
    return loadBathymetryDataset()?.imagePath ?? null;
}

function createLookupError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function lookupGrid(grid, latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw createLookupError("INVALID_COORDINATES", "Latitude and longitude must be finite numbers.");
    }

    const { south, west, north, east } = grid.bounds;
    if (latitude < south || latitude > north || longitude < west || longitude > east) {
        throw createLookupError("OUT_OF_BOUNDS", "The requested coordinate is outside the bathymetry grid.", {
            bounds: { south, west, north, east },
        });
    }

    const column = Math.min(grid.ncols - 1, Math.floor((longitude - west) / grid.cellsize));
    const row = Math.min(grid.nrows - 1, Math.floor((north - latitude) / grid.cellsize));
    const elevationMeters = grid.values[row * grid.ncols + column];
    const isNoData = elevationMeters === grid.nodataValue;
    const cellLongitude = west + (column + 0.5) * grid.cellsize;
    const cellLatitude = north - (row + 0.5) * grid.cellsize;

    return {
        latitude,
        longitude,
        cell: {
            row,
            column,
            latitude: cellLatitude,
            longitude: cellLongitude,
        },
        elevationMeters: isNoData ? null : elevationMeters,
        depthMeters: isNoData || elevationMeters >= 0 ? null : -elevationMeters,
        surface: isNoData ? "nodata" : elevationMeters >= 0 ? "land" : "underwater",
    };
}

function lookupBathymetry(latitude, longitude) {
    const dataset = loadBathymetryDataset();
    if (!dataset) {
        throw createLookupError("BATHYMETRY_UNAVAILABLE", "Bathymetry data is unavailable.");
    }
    return lookupGrid(dataset.grid, latitude, longitude);
}

function resetBathymetryCacheForTests() {
    cachedDataset = undefined;
    loadAttempted = false;
    emittedWarnings.clear();
}

module.exports = {
    DEFAULT_BATHYMETRY_DIR,
    discoverBathymetryFiles,
    parseAsciiGrid,
    loadBathymetryDataset,
    getBathymetryConfig,
    getBathymetryImagePath,
    lookupGrid,
    lookupBathymetry,
    resetBathymetryCacheForTests,
};
