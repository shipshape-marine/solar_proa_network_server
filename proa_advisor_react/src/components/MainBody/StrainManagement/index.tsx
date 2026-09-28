import { useEffect, useRef, useState } from "react";
import DynamicLineChart from "../../Chart/DynamicLineChart";
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Slider from "@mui/material/Slider";
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import { jwtDecode } from "jwt-decode";
import { resolveTimeMs } from "../recovery_time";
import '../../../data_type/strain';

const ARRAY_LENGTH = 500;

function isAuthenticated(): boolean {
    const token = localStorage.getItem('token');
    if (!token) return false;
    try {
        const decoded: any = jwtDecode(token);
        return decoded.exp > Date.now() / 1000;
    } catch {
        return false;
    }
}

function getAuthHeaders(): HeadersInit {
    const token = localStorage.getItem('token');
    return {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };
}

export default function StrainManagement({ data }: { data: StrainData | null }) {
    const [xData, setXData] = useState<number[]>([]);
    const [readings, setReadings] = useState<number[]>([]);
    const [displayDataLength, setDisplayDataLength] = useState<number>(ARRAY_LENGTH);
    const lengthSliderRef = useRef<HTMLInputElement>(null);
    const startTime = useRef<number>(Date.now());

    // Command panel state
    const [authenticated, setAuthenticated] = useState(isAuthenticated());
    const [commandStatus, setCommandStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [macAddress, setMacAddress] = useState("");
    const [selectedRate, setSelectedRate] = useState<string>("20");

    // Re-check auth on focus (token may have been set in Dev Panel)
    useEffect(() => {
        const checkAuth = () => setAuthenticated(isAuthenticated());
        window.addEventListener('focus', checkAuth);
        const interval = setInterval(checkAuth, 5000);
        return () => {
            window.removeEventListener('focus', checkAuth);
            clearInterval(interval);
        };
    }, []);

    useEffect(() => {
        if (!authenticated) {
            setMacAddress("");
            return;
        }

        let cancelled = false;
        const fetchMacAddress = async () => {
            try {
                const response = await fetch("/get_mac_address?node=strain", {
                    headers: getAuthHeaders(),
                });
                const result = await response.json();
                if (!response.ok || !result.macAddress) {
                    throw new Error(result.message || "Failed to fetch the strain node MAC address");
                }
                if (!cancelled) {
                    setMacAddress(result.macAddress);
                }
            } catch (error: any) {
                if (!cancelled) {
                    setCommandStatus({
                        type: 'error',
                        message: error.message || 'Failed to fetch the strain node MAC address',
                    });
                }
            }
        };

        fetchMacAddress();
        return () => {
            cancelled = true;
        };
    }, [authenticated]);

    // Fetch initial historical data on mount. Switching tabs unmounts this
    // component, so this also restores the chart when the tab is reopened.
    useEffect(() => {
        if (xData.length === 0) {
            const fetchInitialData = async () => {
                try {
                    const response = await fetch("/initial_strain_data");
                    const initialData: StrainReading[] = await response.json();
                    populateInitialData(initialData);
                } catch (error) {
                    console.log("Falling back to localhost for initial strain data.");
                    try {
                        const response = await fetch("http://localhost:4000/initial_strain_data");
                        const initialData: StrainReading[] = await response.json();
                        populateInitialData(initialData);
                    } catch (err) {
                        console.error("Fallback fetch failed:", err);
                    }
                }
            };
            fetchInitialData();
        }
    }, []);

    function populateInitialData(initialData: StrainReading[]) {
        let defaultLength = ARRAY_LENGTH;
        const saved = localStorage.getItem("strainDisplayDataLength");
        if (saved) {
            defaultLength = parseInt(saved);
            setDisplayDataLength(defaultLength);
        }
        if (!initialData || initialData.length === 0) return;

        // Rebuild the x-axis from the stored host receive time so the spacing
        // reflects the node's actual sample rate (configurable 10-320 SPS).
        // Rows written before recv_ms existed fall back to the 1s timestamp.
        const baseMs = resolveTimeMs(initialData[0], 0);
        const xArr: number[] = [];
        const readingArr: number[] = [];

        initialData.forEach((d, i) => {
            xArr.push((resolveTimeMs(d, i) - baseMs) / 1000);
            readingArr.push(d.adjustedReading);
        });

        setXData(xArr.slice(-defaultLength));
        setReadings(readingArr.slice(-defaultLength));

        // Rebase startTime so live data continues the series instead of
        // restarting the x-axis at zero.
        const lastTime = xArr[xArr.length - 1] || 0;
        startTime.current = Date.now() - lastTime * 1000;
    }

    // Append live data
    useEffect(() => {
        if (data) {
            const sliceLength = parseInt(lengthSliderRef.current?.value || displayDataLength.toString());
            const nowSec = (Date.now() - startTime.current) / 1000;

            setXData((prev) => [...prev, nowSec].slice(-sliceLength));
            setReadings((prev) => [...prev, data.adjustedReading].slice(-sliceLength));
        }
    }, [data]);

    useEffect(() => {
        if (lengthSliderRef.current) {
            lengthSliderRef.current.value = displayDataLength.toString();
        }
        if (displayDataLength !== ARRAY_LENGTH) {
            localStorage.setItem("strainDisplayDataLength", displayDataLength.toString());
        }
    }, [displayDataLength]);

    // Load saved display length
    useEffect(() => {
        const saved = localStorage.getItem("strainDisplayDataLength");
        if (saved) {
            setDisplayDataLength(parseInt(saved));
        }
    }, []);

    // Send command to strain node via backend
    async function sendCommand(command: string) {
        setCommandStatus(null);
        if (!macAddress) {
            setCommandStatus({ type: 'error', message: 'Node MAC address is not available' });
            return;
        }
        try {
            const response = await fetch("/send_command", {
                method: "POST",
                headers: getAuthHeaders(),
                body: JSON.stringify({ macAddress, command })
            });
            const result = await response.json();
            if (response.ok) {
                setCommandStatus({ type: 'success', message: result.message });
            } else {
                setCommandStatus({ type: 'error', message: result.message || 'Failed to send command' });
            }
        } catch (err: any) {
            setCommandStatus({ type: 'error', message: err.message || 'Network error' });
        }
    }

    return (
        <div className="strain-management">
            {/* Live Reading Display */}
            <Card sx={{ mb: 2 }}>
                <CardContent>
                    <Typography variant="h6" gutterBottom>Strain Gauge - Live</Typography>
                    <Box sx={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: 2 }}>
                        <Box sx={{ textAlign: 'center', minWidth: 150 }}>
                            <Typography variant="caption" color="text.secondary">Adjusted Reading</Typography>
                            <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
                                {data?.adjustedReading !== undefined ? data.adjustedReading : "--"}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">raw ADC counts</Typography>
                        </Box>
                        <Box sx={{ textAlign: 'center', minWidth: 100 }}>
                            <Typography variant="caption" color="text.secondary">Packet Counter</Typography>
                            <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
                                {data?.counter !== undefined ? data.counter : "--"}
                            </Typography>
                        </Box>
                    </Box>
                </CardContent>
            </Card>

            {/* Command Panel - Only visible when authenticated */}
            {authenticated && (
                <Card sx={{ mb: 2 }}>
                    <CardContent>
                        <Typography variant="h6" gutterBottom>Send Command</Typography>

                        <Box sx={{ mb: 2 }}>
                            <TextField
                                label="Node MAC Address"
                                value={macAddress}
                                onChange={(e) => setMacAddress(e.target.value)}
                                size="small"
                                fullWidth
                                sx={{ mb: 1.5 }}
                            />
                        </Box>

                        {/* Quick command buttons */}
                        <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
                            <Button variant="contained" color="success" size="small" onClick={() => sendCommand("START")}>
                                START
                            </Button>
                            <Button variant="contained" color="error" size="small" onClick={() => sendCommand("STOP")}>
                                STOP
                            </Button>
                            <Button variant="outlined" size="small" onClick={() => sendCommand("TARE")}>
                                TARE
                            </Button>
                        </Stack>

                        {/* Sample rate control */}
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
                            <FormControl size="small" sx={{ minWidth: 120 }}>
                                <InputLabel>Sample Rate</InputLabel>
                                <Select
                                    value={selectedRate}
                                    label="Sample Rate"
                                    onChange={(e) => setSelectedRate(e.target.value)}
                                >
                                    <MenuItem value="10">10 SPS</MenuItem>
                                    <MenuItem value="20">20 SPS</MenuItem>
                                    <MenuItem value="40">40 SPS</MenuItem>
                                    <MenuItem value="80">80 SPS</MenuItem>
                                    <MenuItem value="320">320 SPS</MenuItem>
                                </Select>
                            </FormControl>
                            <Button variant="outlined" size="small" onClick={() => sendCommand(`RATE:${selectedRate}`)}>
                                Apply Rate
                            </Button>
                        </Stack>

                        {/* Status feedback */}
                        {commandStatus && (
                            <Alert severity={commandStatus.type} sx={{ mt: 1.5 }} onClose={() => setCommandStatus(null)}>
                                {commandStatus.message}
                            </Alert>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Chart Controls */}
            <Box sx={{ width: 300, mb: 2 }}>
                <Typography variant="body2">Points displayed: {displayDataLength}</Typography>
                <Slider
                    ref={lengthSliderRef}
                    min={10} max={2000} step={10}
                    valueLabelDisplay="auto"
                    value={displayDataLength}
                    onChange={(_event, value) => setDisplayDataLength(value as number)}
                />
            </Box>

            {/* Live Chart */}
            <DynamicLineChart
                title="Strain Reading Over Time"
                lineNames={['Adjusted Reading']}
                xAxis={{ xData }}
                yAxis={{
                    yData: [readings],
                    yTitle: "ADC Counts",
                    yUnit: "counts",
                    significantDigits: 0
                }}
            />
        </div>
    );
}
