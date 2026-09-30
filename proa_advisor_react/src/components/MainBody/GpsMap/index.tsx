import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
    CircleMarker,
    ImageOverlay,
    LayersControl,
    MapContainer,
    Polyline,
    TileLayer,
    useMap,
} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import '../../../data_type/gps.tsx';

const MAX_TRACK_POINTS = 10000;
const LOCALHOST_API_BASE_URL = 'http://localhost:4000';

type MapConfig = {
    center: [number, number];
    bounds: [[number, number], [number, number]];
    zoom: {
        initial: number;
        min: number;
        max: number;
    };
    tileUrl: string;
};

type MapBounds = [[number, number], [number, number]];

type BathymetryConfig = {
    available: boolean;
    warning?: string;
    imageUrl?: string;
    opacity?: number;
    bounds?: MapBounds;
    grid?: {
        ncols: number;
        nrows: number;
        cellsize: number;
        nodataValue: number;
    };
};

type BathymetrySample = {
    latitude: number;
    longitude: number;
    cell: {
        row: number;
        column: number;
        latitude: number;
        longitude: number;
    };
    elevationMeters: number | null;
    depthMeters: number | null;
    surface: 'nodata' | 'land' | 'underwater';
};

type BathymetryHoverState = {
    pointer: [number, number];
    status: 'waiting' | 'loading' | 'ready' | 'error';
    sample?: BathymetrySample;
    message?: string;
};

function parseMapConfig(value: unknown): MapConfig | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const config = value as Record<string, unknown>;
    const rawCenter = config.center;
    const bounds = config.bounds as Record<string, unknown> | undefined;
    const zoom = config.zoom as Record<string, unknown> | undefined;
    let center: [number, number] | null = null;

    if (Array.isArray(rawCenter)
        && rawCenter.length === 2
        && rawCenter.every((coordinate) => typeof coordinate === 'number')) {
        center = [rawCenter[0], rawCenter[1]];
    } else if (rawCenter && typeof rawCenter === 'object') {
        const objectCenter = rawCenter as Record<string, unknown>;
        if (typeof objectCenter.latitude === 'number' && typeof objectCenter.longitude === 'number') {
            center = [objectCenter.latitude, objectCenter.longitude];
        }
    }

    if (!center
        || !bounds
        || !zoom
        || typeof bounds.south !== 'number'
        || typeof bounds.west !== 'number'
        || typeof bounds.north !== 'number'
        || typeof bounds.east !== 'number'
        || typeof zoom.initial !== 'number'
        || typeof zoom.min !== 'number'
        || typeof zoom.max !== 'number'
        || typeof config.tileUrl !== 'string') {
        return null;
    }

    return {
        center,
        bounds: [
            [bounds.south, bounds.west],
            [bounds.north, bounds.east],
        ],
        zoom: {
            initial: zoom.initial,
            min: zoom.min,
            max: zoom.max,
        },
        tileUrl: config.tileUrl,
    };
}

function parseBathymetryConfig(value: unknown): BathymetryConfig | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const config = value as Record<string, unknown>;
    if (typeof config.available !== 'boolean') {
        return null;
    }

    if (!config.available) {
        return {
            available: false,
            warning: typeof config.warning === 'string' ? config.warning : undefined,
        };
    }

    const rawBounds = config.bounds;
    const imageUrl = config.imageUrl;
    const rawOpacity = config.opacity;
    const grid = config.grid as Record<string, unknown> | undefined;
    if (!Array.isArray(rawBounds)
        || rawBounds.length !== 2
        || !Array.isArray(rawBounds[0])
        || !Array.isArray(rawBounds[1])
        || rawBounds[0].length !== 2
        || rawBounds[1].length !== 2
        || !rawBounds.flat().every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
        || typeof imageUrl !== 'string'
        || !grid
        || typeof grid.ncols !== 'number'
        || typeof grid.nrows !== 'number'
        || typeof grid.cellsize !== 'number'
        || typeof grid.nodataValue !== 'number') {
        return null;
    }

    return {
        available: true,
        imageUrl,
        opacity: typeof rawOpacity === 'number' && Number.isFinite(rawOpacity)
            ? Math.min(1, Math.max(0, rawOpacity))
            : 0.45,
        bounds: [
            [rawBounds[0][0], rawBounds[0][1]],
            [rawBounds[1][0], rawBounds[1][1]],
        ],
        grid: {
            ncols: grid.ncols,
            nrows: grid.nrows,
            cellsize: grid.cellsize,
            nodataValue: grid.nodataValue,
        },
    };
}

function RecenterOnFirstFix({ point, zoom }: { point: GPSData | null; zoom: number }) {
    const map = useMap();
    const hasCentered = useRef(false);

    useEffect(() => {
        if (point && !hasCentered.current) {
            map.setView([point.latitude, point.longitude], zoom);
            hasCentered.current = true;
        }
    }, [map, point, zoom]);

    return null;
}

function isInsideBounds([latitude, longitude]: [number, number], bounds: MapBounds) {
    return latitude >= bounds[0][0]
        && latitude <= bounds[1][0]
        && longitude >= bounds[0][1]
        && longitude <= bounds[1][1];
}

function BathymetryHover({
    config,
    onChange,
}: {
    config: BathymetryConfig;
    onChange: (state: BathymetryHoverState | null) => void;
}) {
    const map = useMap();
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestRef = useRef<AbortController | null>(null);

    useEffect(() => {
        const clearPending = () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            requestRef.current?.abort();
            requestRef.current = null;
        };

        const scheduleLookup = (pointer: [number, number]) => {
            clearPending();

            if (!config.bounds || !isInsideBounds(pointer, config.bounds)) {
                onChange(null);
                return;
            }

            onChange({ pointer, status: 'waiting' });
            timerRef.current = setTimeout(async () => {
                const controller = new AbortController();
                requestRef.current = controller;
                onChange({ pointer, status: 'loading' });

                try {
                    const params = new URLSearchParams({
                        lat: pointer[0].toFixed(7),
                        lng: pointer[1].toFixed(7),
                    });
                    const response = await fetch(`/bathymetry/depth?${params.toString()}`, {
                        signal: controller.signal,
                    });
                    const body = await response.json() as { message?: string } & Partial<BathymetrySample>;
                    if (!response.ok) {
                        throw new Error(body.message || `Depth lookup failed with HTTP ${response.status}`);
                    }
                    if (!controller.signal.aborted) {
                        onChange({ pointer, status: 'ready', sample: body as BathymetrySample });
                    }
                } catch (error) {
                    if (controller.signal.aborted) {
                        return;
                    }
                    onChange({
                        pointer,
                        status: 'error',
                        message: error instanceof Error ? error.message : 'Depth lookup failed.',
                    });
                } finally {
                    if (requestRef.current === controller) {
                        requestRef.current = null;
                    }
                }
            }, 1000);
        };

        const handleMouseMove = (event: MouseEvent) => {
            const mapBounds = map.getContainer().getBoundingClientRect();
            const point = map.containerPointToLatLng([
                event.clientX - mapBounds.left,
                event.clientY - mapBounds.top,
            ]);
            scheduleLookup([point.lat, point.lng]);
        };
        const handleMouseLeave = () => {
            clearPending();
            onChange(null);
        };
        const container = map.getContainer();

        container.addEventListener('mousemove', handleMouseMove);
        container.addEventListener('mouseleave', handleMouseLeave);

        return () => {
            container.removeEventListener('mousemove', handleMouseMove);
            container.removeEventListener('mouseleave', handleMouseLeave);
            clearPending();
        };
    }, [config.bounds, map, onChange]);

    return null;
}

function formatNumber(value: number, digits = 5) {
    return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

async function requestMapConfig(url: string): Promise<{ config: MapConfig; responseUrl: string }> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Map configuration request failed with HTTP ${response.status}`);
    }

    const config = parseMapConfig(await response.json());
    if (!config) {
        throw new Error("Map configuration response has an invalid shape.");
    }

    return { config, responseUrl: response.url };
}

async function requestBathymetryConfig(url: string): Promise<{ config: BathymetryConfig; responseUrl: string }> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Bathymetry configuration request failed with HTTP ${response.status}`);
    }

    const config = parseBathymetryConfig(await response.json());
    if (!config) {
        throw new Error("Bathymetry configuration response has an invalid shape.");
    }

    return { config, responseUrl: response.url };
}

function resolveResourceUrl(resourceUrl: string, responseUrl: string) {
    if (/^https?:\/\//i.test(resourceUrl)) {
        return resourceUrl;
    }

    if (resourceUrl.startsWith('/')) {
        return `${new URL(responseUrl).origin}${resourceUrl}`;
    }

    throw new Error("Map configuration returned an unsupported resource URL.");
}

export default function GpsMap({ data, track }: { data: GPSData | null; track: GPSData[] }) {
    const [mapConfig, setMapConfig] = useState<MapConfig | null>(null);
    const [bathymetryConfig, setBathymetryConfig] = useState<BathymetryConfig | null>(null);
    const [bathymetryHover, setBathymetryHover] = useState<BathymetryHoverState | null>(null);
    const [mapConfigError, setMapConfigError] = useState(false);
    const [tileError, setTileError] = useState(false);
    const latestPoint = track.length > 0 ? track[track.length - 1] : null;
    const hasCurrentFix = data?.valid === true;

    useEffect(() => {
        let cancelled = false;

        requestMapConfig("/map_config")
            .catch(async (error) => {
                console.warn("Map configuration request failed; trying localhost backend:", error);
                return requestMapConfig(`${LOCALHOST_API_BASE_URL}/map_config`);
            })
            .then(({ config, responseUrl }) => {
                config.tileUrl = resolveResourceUrl(config.tileUrl, responseUrl);
                if (!cancelled) {
                    setMapConfig(config);
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    console.error("Failed to load map configuration:", error);
                    setMapConfigError(true);
                }
            });

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        requestBathymetryConfig("/bathymetry_config")
            .catch(async (error) => {
                console.warn("Bathymetry configuration request failed; trying localhost backend:", error);
                return requestBathymetryConfig(`${LOCALHOST_API_BASE_URL}/bathymetry_config`);
            })
            .then(({ config, responseUrl }) => {
                if (config.available && config.imageUrl) {
                    config.imageUrl = resolveResourceUrl(config.imageUrl, responseUrl);
                }
                if (!cancelled) {
                    setBathymetryConfig(config);
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    console.warn("Bathymetry data is unavailable:", error);
                    setBathymetryConfig({
                        available: false,
                        warning: "Bathymetry data is unavailable; the bathymetry layer is disabled.",
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <Stack spacing={2} className="gps-map-page">
            <Card>
                <CardContent>
                    <Typography variant="h6" gutterBottom>
                        GPS Route - Live
                    </Typography>
                    <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap" }} useFlexGap>
                        <Typography variant="body2">
                            Latitude: {latestPoint ? formatNumber(latestPoint.latitude) : '--'}
                        </Typography>
                        <Typography variant="body2">
                            Longitude: {latestPoint ? formatNumber(latestPoint.longitude) : '--'}
                        </Typography>
                        <Typography variant="body2">
                            Satellites: {latestPoint ? latestPoint.satellites : '--'}
                        </Typography>
                        <Typography variant="body2">
                            HDOP: {latestPoint ? `${formatNumber(latestPoint.hdop, 2)} m` : '--'}
                        </Typography>
                        <Typography variant="body2">
                            Speed: {latestPoint ? `${formatNumber(latestPoint.speed, 1)} km/h` : '--'}
                        </Typography>
                        <Typography variant="body2">
                            Points: {track.length}
                        </Typography>
                    </Stack>
                    {!hasCurrentFix && (
                        <Alert severity={data && !data.valid ? 'warning' : 'info'} sx={{ mt: 2 }}>
                            {data && !data.valid && latestPoint
                                ? 'GPS fix lost; showing the last valid route position.'
                                : data && !data.valid
                                ? 'GPS data is arriving, but there is no valid fix yet.'
                                : 'Waiting for GPS data from the serial reader.'}
                        </Alert>
                    )}
                </CardContent>
            </Card>

            {mapConfigError ? (
                <Alert severity="error">Unable to load map configuration from the server.</Alert>
            ) : mapConfig ? (
                <Box className="gps-map-shell">
                    <MapContainer
                        center={mapConfig.center}
                        zoom={mapConfig.zoom.initial}
                        minZoom={mapConfig.zoom.min}
                        maxZoom={mapConfig.zoom.max}
                        maxBounds={mapConfig.bounds}
                        maxBoundsViscosity={1}
                        scrollWheelZoom
                    >
                        <TileLayer
                            url={mapConfig.tileUrl}
                            attribution={'&copy; <a href="https://opentopomap.org/about" target="_blank" rel="noreferrer">OpenTopoMap</a> (&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>)'}
                            eventHandlers={{
                                tileerror: () => setTileError(true),
                            }}
                        />
                        {bathymetryConfig?.available
                            && bathymetryConfig.imageUrl
                            && bathymetryConfig.bounds
                            && (
                                <LayersControl position="topright">
                                    <LayersControl.Overlay checked name="Bathymetry">
                                        <ImageOverlay
                                            url={bathymetryConfig.imageUrl}
                                            bounds={bathymetryConfig.bounds}
                                            opacity={bathymetryConfig.opacity ?? 0.45}
                                            zIndex={200}
                                        />
                                    </LayersControl.Overlay>
                                </LayersControl>
                            )}
                        {bathymetryConfig?.available && (
                            <BathymetryHover
                                config={bathymetryConfig}
                                onChange={setBathymetryHover}
                            />
                        )}
                        <RecenterOnFirstFix point={latestPoint} zoom={mapConfig.zoom.initial} />
                        {track.length > 1 && (
                            <Polyline
                                positions={track
                                    .slice(-MAX_TRACK_POINTS)
                                    .map((point) => [point.latitude, point.longitude] as [number, number])}
                                pathOptions={{ color: '#1976d2', weight: 4 }}
                            />
                        )}
                        {latestPoint && (
                            <CircleMarker
                                center={[latestPoint.latitude, latestPoint.longitude]}
                                radius={8}
                                pathOptions={{ color: '#d32f2f', fillColor: '#f44336', fillOpacity: 0.9 }}
                            />
                        )}
                    </MapContainer>
                    {bathymetryHover && (
                        <Box className="bathymetry-hover-panel">
                            <Typography variant="caption" sx={{ display:"block" }}>
                                Lat: {formatNumber(bathymetryHover.pointer[0])},{' '}
                                Lon: {formatNumber(bathymetryHover.pointer[1])}
                            </Typography>
                            <br />
                            {bathymetryHover.status === 'waiting' || bathymetryHover.status === 'loading' ? (
                                <Typography variant="caption" sx={{ display:"block" }}>
                                    <br />
                                    {bathymetryHover.status === 'waiting' ? 'Hold to sample depth...' : 'Reading depth...'}
                                </Typography>
                            ) : bathymetryHover.status === 'error' ? (
                                <Typography variant="caption" color="error" sx={{ display:"block" }}>
                                    {bathymetryHover.message}
                                </Typography>
                            ) : bathymetryHover.sample?.surface === 'underwater' ? (
                                <Typography variant="caption" sx={{ display:"block" }}>
                                    Depth: {bathymetryHover.sample.depthMeters?.toFixed(1)} m
                                </Typography>
                            ) : bathymetryHover.sample?.surface === 'land' ? (
                                <Typography variant="caption" sx={{ display:"block" }}>
                                    Land elevation: {bathymetryHover.sample.elevationMeters?.toFixed(1)} m
                                </Typography>
                            ) : (
                                <Typography variant="caption" sx={{ display:"block" }}>
                                    No depth data at this location.
                                </Typography>
                            )}
                            {bathymetryHover.status === 'ready' && bathymetryHover.sample && (
                                <Typography variant="caption" sx={{ display:"block" }}>
                                    Grid cell: {formatNumber(bathymetryHover.sample.cell.latitude)},{' '}
                                    {formatNumber(bathymetryHover.sample.cell.longitude)}
                                </Typography>
                            )}
                        </Box>
                    )}
                </Box>
            ) : (
                <Alert severity="info">Loading map configuration...</Alert>
            )}

            {bathymetryConfig && !bathymetryConfig.available && (
                <Alert severity="warning">
                    {bathymetryConfig.warning || 'Bathymetry data is unavailable; the layer was not rendered.'}
                </Alert>
            )}

            {tileError && (
                <Alert severity="warning">
                    One or more offline map tiles are unavailable. Add the configured tile bundle under{' '}
                    <code>/map-tiles/{'{z}'}/{'{x}'}/{'{y}'}.png</code> before running without internet access.
                </Alert>
            )}
        </Stack>
    );
}
