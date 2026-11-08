import { useEffect, useState } from 'react';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import './styles.css';

type ServerMode = 'normal' | 'test' | 'game';
const SERVER_MODES: { mode: ServerMode; label: string }[] = [
    { mode: 'normal', label: 'Normal' },
    { mode: 'test', label: 'Test' },
    { mode: 'game', label: 'Game' },
];
type StatusKind = 'success' | 'error' | 'info';
const TIMEOUT_DURATION = 2000; // Duration in milliseconds for status message to disappear
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
        return await response.json(); // Attempt to parse JSON to check if the response is valid
    } catch (error) {
        const response = await fetch(LOCALHOST_API_BASE_URL + route, requestInit);
        try {
            return await response.json(); // Attempt to parse JSON to check if the response is valid
        } catch (error) {
            throw new Error('Failed to fetch from both primary and fallback routes');
        }
    }
}

export default function ServerManagementTab() {
    const [currentMode, setCurrentMode] = useState<ServerMode | null>(null);
    const [isLoadingMode, setIsLoadingMode] = useState(true);
    const [statusMessage, setStatusMessage] = useState('');
    const [statusKind, setStatusKind] = useState<StatusKind>('info');

    useEffect(() => {
        loadCurrentMode();
    }, []);

    useEffect(() => {
        if (!statusMessage) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            setStatusMessage('');
        }, 4000);

        return () => window.clearTimeout(timeoutId);
    }, [statusMessage]);

    async function loadCurrentMode() {
        setIsLoadingMode(true);
        try {
            const data = await fetchWithFallback('/get_curr_mode');
            if (SERVER_MODES.some(({ mode }) => mode === data.mode)) {
                setCurrentMode(data.mode);
            } else {
                throw new Error('Invalid mode response');
            }
        } catch (error) {
            setCurrentMode(null);
            setStatusKind('error');
            setStatusMessage('Failed to load current server mode.');
        } finally {
            setIsLoadingMode(false);
        }
    }

    async function handleSwitchMode(newMode: ServerMode) {
        setStatusMessage('');
        try {
            // fetchWithFallback already returns parsed JSON
            const data = await fetchWithFallback(`/set_mode_and_restart?mode=${newMode}`);
            setStatusKind('success');
            setStatusMessage(data.message || 'Server mode switched.');
        } catch (error) {
            // Don't set status message here, as the server might be restarting and not responding
        }
        window.setTimeout(() => {
            loadCurrentMode();
        }, TIMEOUT_DURATION);
    }
    
    async function handleUpdateAndRestartServer() {
        const confirmed = window.confirm('Update repository and restart server now? Active connections will be interrupted during restart only.');
        if (!confirmed) {
            return;
        }

        setStatusMessage('');
        try {
            const data = await fetchWithFallback('/update_repo');
            setStatusKind('success');
            setStatusMessage(data.message || 'Repository updated and server restarting...');
            handleRestartServer();
        } catch (error) {
            setStatusKind('error');
            setStatusMessage('Failed to update repository.');
        }
    }

    async function handleRestartServer() {
        const confirmed = window.confirm('Restart server now? Active connections will be interrupted.');
        if (!confirmed) {
            return;
        }

        setStatusMessage('');
        try {
            const data = await fetchWithFallback('/rebuild_and_restart');
            setStatusKind('info');
            setStatusMessage(data.message || 'Server is restarting...');
        } catch (error) {
            setStatusKind('info');
            setStatusMessage('Restart command sent. Connection may close while server restarts.');
        }
    }

    async function handleStopServer() {
        const confirmed = window.confirm(
            'Stop server now?\n\nTo turn it back on, you need to restart the device.'
        );
        if (!confirmed) {
            return;
        }

        setStatusMessage('');
        try {
            const data = await fetchWithFallback('/stop_server');
            if (!data) {
                throw new Error('Failed to stop server');
            }
            setStatusKind('info');
            setStatusMessage(data.message || 'Server is stopping...');
        } catch (error) {
            setStatusKind('info');
            setStatusMessage('Stop command sent. To turn it back on, restart the device.');
        }
    }

    return (
        <section className="server-management-tab">
            <p>
                Current mode:{' '}
                {isLoadingMode
                    ? 'Loading...'
                    : SERVER_MODES.find(({ mode }) => mode === currentMode)?.label ?? 'Unavailable'}
            </p>
            <Stack spacing={2} sx={{ width: '70%' }}>
                <Stack direction="row" spacing={2}>
                    {SERVER_MODES.map(({ mode, label }) => (
                        <Button
                            key={mode}
                            variant="contained"
                            sx={{ flex: 1 }}
                            disabled={isLoadingMode || mode === currentMode}
                            onClick={() => handleSwitchMode(mode)}
                        >
                            {label} Mode
                        </Button>
                    ))}
                </Stack>
                <Button variant="contained" onClick={handleUpdateAndRestartServer}>
                    Update Repository and Restart Server
                </Button>
                <Button variant="contained" onClick={handleRestartServer}>
                    Restart Server
                </Button>
                <Button color="error" variant="contained" onClick={handleStopServer}>
                    Stop Server
                </Button>
            </Stack>
            {statusMessage && (
                <p className={`server-management-status ${statusKind}`}>
                    {statusMessage}
                </p>
            )}
        </section>
    );
}
