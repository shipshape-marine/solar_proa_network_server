import { useEffect, useMemo, useState } from 'react';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import './styles.css';

type StatusKind = 'success' | 'error' | 'info';

type SensorRunSummary = {
    run_id: number;
    start_row_id: number;
    start_datetime: string;
    row_count: number;
};

/**
 * Each sensor stream keeps its own run_id counter, so every section
 * lists and downloads runs independently. "Power 2" and "Strain 2" are unrelated
 * time windows, which is why the run_id is always shown next to its own type.
 */
type SensorType = 'power' | 'imu' | 'strain' | 'gps';

const SENSORS: { type: SensorType; label: string; table: string }[] = [
    { type: 'power', label: 'Power', table: 'SOCSensor' },
    { type: 'imu', label: 'IMU', table: 'IMUReadings' },
    { type: 'strain', label: 'Strain', table: 'StrainReadings' },
    { type: 'gps', label: 'GPS', table: 'GPSReadings' },
];

const LOCALHOST_API_BASE_URL = 'http://localhost:4000';

function getAuthHeaders() {
    const headers = new Headers();
    const token = localStorage.getItem('token');
    if (token) {
        headers.set('Authorization', 'Bearer ' + token);
    }
    return headers;
}

async function fetchWithFallback(route: string) {
    const requestInit: RequestInit = {
        method: 'GET',
        headers: getAuthHeaders(),
    };

    try {
        const response = await fetch(route, requestInit);
        return await response.json();
    } catch (error) {
        const response = await fetch(LOCALHOST_API_BASE_URL + route, requestInit);
        try {
            return await response.json();
        } catch (fallbackError) {
            throw new Error('Failed to fetch from both primary and fallback routes');
        }
    }
}

async function fetchRawWithFallback(route: string, requestInit: RequestInit) {
    const isCsvDownloadResponse = (response: Response) => {
        const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
        const contentDisposition = (response.headers.get('Content-Disposition') || '').toLowerCase();
        return contentType.includes('text/csv') || contentDisposition.includes('attachment');
    };

    const shouldRetryAgainstBackend = (response: Response) => {
        const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
        return contentType.includes('text/html');
    };

    try {
        const response = await fetch(route, requestInit);
        if (isCsvDownloadResponse(response) || !shouldRetryAgainstBackend(response)) {
            return response;
        }
    } catch (error) {
        // Retry against explicit backend URL.
    }
    return await fetch(LOCALHOST_API_BASE_URL + route, requestInit);
}

function getFileNameFromContentDisposition(contentDisposition: string | null) {
    if (!contentDisposition) {
        return null;
    }
    const match = /filename="([^"]+)"/i.exec(contentDisposition);
    return match?.[1] ?? null;
}

function formatStartTime(value: string) {
    const dt = new Date(value.replace(' ', 'T') + 'Z');
    if (Number.isNaN(dt.getTime())) {
        return value;
    }
    return dt.toLocaleString();
}

function formatRowCount(count: number) {
    return count.toLocaleString();
}

/**
 * One independent sensor block: run picker plus CSV download.
 *
 * Each block owns its own loading, selection and status state so a failure or a
 * slow download in one section never blanks out the other two.
 */
function SensorRunSection({
    type,
    label,
    table,
    downloadDisabled,
    onDownloadStateChange,
}: {
    type: SensorType;
    label: string;
    table: string;
    downloadDisabled: boolean;
    onDownloadStateChange: (isDownloading: boolean) => void;
}) {
    const [statusMessage, setStatusMessage] = useState('');
    const [statusKind, setStatusKind] = useState<StatusKind>('info');
    const [isDownloading, setIsDownloading] = useState(false);
    const [isLoadingRuns, setIsLoadingRuns] = useState(true);
    const [runSummaries, setRunSummaries] = useState<SensorRunSummary[]>([]);
    const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

    const selectedRunSummary = useMemo(
        () => runSummaries.find((run) => run.run_id === selectedRunId) ?? null,
        [runSummaries, selectedRunId],
    );

    useEffect(() => {
        if (!statusMessage || isDownloading) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            setStatusMessage('');
        }, 4000);

        return () => window.clearTimeout(timeoutId);
    }, [statusMessage, isDownloading]);

    useEffect(() => {
        loadRunSummaries();
    }, []);

    async function loadRunSummaries() {
        setIsLoadingRuns(true);
        try {
            const data = await fetchWithFallback(`/sensor_runs?type=${type}`);
            if (!data || !Array.isArray(data.runs)) {
                throw new Error(data?.message || `Failed to load ${label} runs.`);
            }

            const runs = data.runs as SensorRunSummary[];
            setRunSummaries(runs);

            if (runs.length > 0) {
                setSelectedRunId(runs[0].run_id);
            } else {
                setSelectedRunId(null);
                setStatusKind('info');
                setStatusMessage(`No ${label} runs recorded yet.`);
            }
        } catch (error) {
            setStatusKind('error');
            setStatusMessage(error instanceof Error ? error.message : `Failed to load ${label} runs.`);
        } finally {
            setIsLoadingRuns(false);
        }
    }

    async function handleDownload() {
        if (selectedRunSummary === null) {
            setStatusKind('error');
            setStatusMessage(`No ${label} run selected for download.`);
            return;
        }

        setIsDownloading(true);
        onDownloadStateChange(true);
        setStatusKind('info');
        setStatusMessage(`Downloading ${label} ${selectedRunSummary.run_id}...`);

        const route = `/download_sensor?type=${type}&run_id=${selectedRunSummary.run_id}&rowid=${selectedRunSummary.start_row_id}`;

        try {
            const response = await fetchRawWithFallback(route, {
                method: 'GET',
                headers: getAuthHeaders(),
            });

            if (!response.ok) {
                let errorMessage = `Failed to download ${label} data.`;
                try {
                    const body = await response.json();
                    if (body?.message) {
                        errorMessage = body.message;
                    }
                } catch (error) {
                    // Keep the default error message if error body is not JSON.
                }
                throw new Error(errorMessage);
            }

            const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
            const contentDisposition = (response.headers.get('Content-Disposition') || '').toLowerCase();
            if (!contentType.includes('text/csv') && !contentDisposition.includes('attachment')) {
                throw new Error(`Unexpected response received while downloading ${label} CSV.`);
            }

            const blob = await response.blob();
            const fileName =
                getFileNameFromContentDisposition(response.headers.get('Content-Disposition')) ??
                `${table}_run_${selectedRunSummary.run_id}.csv`;

            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(url);

            setStatusKind('success');
            setStatusMessage(`Downloaded ${fileName}.`);
        } catch (error) {
            setStatusKind('error');
            setStatusMessage(error instanceof Error ? error.message : `Failed to download ${label} data.`);
        } finally {
            setIsDownloading(false);
            onDownloadStateChange(false);
        }
    }

    // Downloads share one server-side lock, so block this section while another
    // section is streaming rather than letting the request fail with a 409.
    const blockedByOtherDownload = downloadDisabled && !isDownloading;

    return (
        <div className="database-sensor-section">
            <h3>{label}</h3>

            <div className="database-run-selector">
                <label htmlFor={`run-id-select-${type}`}>{`${label} run`}</label>
                <select
                    id={`run-id-select-${type}`}
                    value={selectedRunId ?? ''}
                    onChange={(event) => setSelectedRunId(Number.parseInt(event.target.value, 10))}
                    disabled={isLoadingRuns || runSummaries.length === 0 || isDownloading}
                >
                    {isLoadingRuns && <option value="">Loading...</option>}
                    {!isLoadingRuns && runSummaries.length === 0 && <option value="">No runs recorded</option>}
                    {runSummaries.map((run) => (
                        <option key={run.run_id} value={run.run_id}>
                            {`${label} ${run.run_id} | Start ${formatStartTime(run.start_datetime)} | ${formatRowCount(run.row_count)} rows`}
                        </option>
                    ))}
                </select>
            </div>

            <Stack spacing={1} sx={{ width: '70%' }}>
                <Button
                    variant="contained"
                    onClick={handleDownload}
                    disabled={isDownloading || isLoadingRuns || selectedRunSummary === null || blockedByOtherDownload}
                >
                    {isDownloading ? `Downloading ${label} Data...` : `Download ${label} Data`}
                </Button>
            </Stack>

            {statusMessage && (
                <p className={`database-management-status ${statusKind}`}>
                    {statusMessage}
                </p>
            )}
        </div>
    );
}

export default function DatabaseManagementTab() {
    // The backend serialises CSV downloads with a single lock, so only one
    // section may stream at a time.
    const [downloadingType, setDownloadingType] = useState<SensorType | null>(null);

    return (
        <section className="database-management-tab">
            {SENSORS.map((sensor, index) => (
                <div key={sensor.type} className="database-sensor-block">
                    {index > 0 && <Divider flexItem sx={{ width: '80%', my: 1 }} />}
                    <SensorRunSection
                        type={sensor.type}
                        label={sensor.label}
                        table={sensor.table}
                        downloadDisabled={downloadingType !== null}
                        onDownloadStateChange={(isDownloading) =>
                            setDownloadingType(isDownloading ? sensor.type : null)
                        }
                    />
                </div>
            ))}
        </section>
    );
}
