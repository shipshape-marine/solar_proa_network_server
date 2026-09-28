import { useEffect, useRef, useState } from "react";
import DynamicLineChart from "../../Chart/DynamicLineChart";
import Grid from '@mui/material/Grid';
import Slider from "@mui/material/Slider";
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import { jwtDecode } from "jwt-decode";
import { resolveTimeMs } from "../recovery_time";
import '../../../data_type/imu';

const ARRAY_LENGTH = 500;

function StatusChip({ label, active }: { label: string; active: boolean }) {
    return (
        <Chip
            label={label}
            color={active ? "success" : "default"}
            variant={active ? "filled" : "outlined"}
            size="small"
            sx={{ mr: 1 }}
        />
    );
}

function AngleDisplay({ label, value, unit = "\u00B0" }: { label: string; value: number | null; unit?: string }) {
    return (
        <Box sx={{ textAlign: 'center', minWidth: 100 }}>
            <Typography variant="caption" color="text.secondary">{label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: "bold" }}>
                {value !== null ? value.toFixed(2) : "--"}{unit}
            </Typography>
        </Box>
    );
}

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

export default function MastMonitor({ data }: { data: IMUData | null }) {
    const [xData, setXData] = useState<number[]>([]);
    const [bendMagnitude, setBendMagnitude] = useState<number[]>([]);
    const [vectorAngle, setVectorAngle] = useState<number[]>([]);
    const [baseRoll, setBaseRoll] = useState<number[]>([]);
    const [basePitch, setBasePitch] = useState<number[]>([]);
    const [topRoll, setTopRoll] = useState<number[]>([]);
    const [topPitch, setTopPitch] = useState<number[]>([]);
    const [topMinusBaseRoll, setTopMinusBaseRoll] = useState<number[]>([]);
    const [topMinusBasePitch, setTopMinusBasePitch] = useState<number[]>([]);

    const [displayDataLength, setDisplayDataLength] = useState<number>(ARRAY_LENGTH);
    const lengthSliderRef = useRef<HTMLInputElement>(null);
    const startTime = useRef<number>(Date.now());

    // Command panel state
    const [authenticated, setAuthenticated] = useState(isAuthenticated());
    const [commandStatus, setCommandStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [macAddress, setMacAddress] = useState("");

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
                const response = await fetch("/get_mac_address?node=imu", {
                    headers: getAuthHeaders(),
                });
                const result = await response.json();
                if (!response.ok || !result.macAddress) {
                    throw new Error(result.message || "Failed to fetch the IMU node MAC address");
                }
                if (!cancelled) {
                    setMacAddress(result.macAddress);
                }
            } catch (error: any) {
                if (!cancelled) {
                    setCommandStatus({
                        type: 'error',
                        message: error.message || 'Failed to fetch the IMU node MAC address',
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
                    const response = await fetch("/initial_imu_data");
                    const initialData: IMUReading[] = await response.json();
                    populateInitialData(initialData);
                } catch (error) {
                    console.log("Falling back to localhost for initial IMU data.");
                    try {
                        const response = await fetch("http://localhost:4000/initial_imu_data");
                        const initialData: IMUReading[] = await response.json();
                        populateInitialData(initialData);
                    } catch (err) {
                        console.error("Fallback fetch failed:", err);
                    }
                }
            };
            fetchInitialData();
        }
    }, []);

    function populateInitialData(initialData: IMUReading[]) {
        let defaultLength = ARRAY_LENGTH;
        if (localStorage.getItem("imuDisplayDataLength")) {
            defaultLength = parseInt(localStorage.getItem("imuDisplayDataLength") || "");
            setDisplayDataLength(defaultLength);
        }
        if (initialData && initialData.length > 0) {
            const xArr: number[] = [];
            const bendArr: number[] = [];
            const vaArr: number[] = [];
            const brArr: number[] = [];
            const bpArr: number[] = [];
            const trArr: number[] = [];
            const tpArr: number[] = [];
            const tmbrArr: number[] = [];
            const tmbpArr: number[] = [];

            // Rebuild the x-axis from the stored host receive time rather than
            // assuming a fixed 10Hz rate.
            const baseMs = resolveTimeMs(initialData[0], 0);

            initialData.forEach((d, i) => {
                xArr.push((resolveTimeMs(d, i) - baseMs) / 1000);
                bendArr.push(d.bendMagnitude);
                vaArr.push(d.vectorAngle);
                brArr.push(d.baseRoll);
                bpArr.push(d.basePitch);
                trArr.push(d.topRoll);
                tpArr.push(d.topPitch);
                tmbrArr.push(d.topMinusBaseRoll);
                tmbpArr.push(d.topMinusBasePitch);
            });

            setXData(xArr.slice(-defaultLength));
            setBendMagnitude(bendArr.slice(-defaultLength));
            setVectorAngle(vaArr.slice(-defaultLength));
            setBaseRoll(brArr.slice(-defaultLength));
            setBasePitch(bpArr.slice(-defaultLength));
            setTopRoll(trArr.slice(-defaultLength));
            setTopPitch(tpArr.slice(-defaultLength));
            setTopMinusBaseRoll(tmbrArr.slice(-defaultLength));
            setTopMinusBasePitch(tmbpArr.slice(-defaultLength));

            // Set startTime so live data continues from where historical left off
            const lastTime = xArr[xArr.length - 1] || 0;
            startTime.current = Date.now() - (lastTime * 1000);
        }
    }

    // Append live data
    useEffect(() => {
        if (data) {
            const sliceLength = parseInt(lengthSliderRef.current?.value || displayDataLength.toString());
            const nowSec = (Date.now() - startTime.current) / 1000;

            setXData((prev) => [...prev, nowSec].slice(-sliceLength));
            setBendMagnitude((prev) => [...prev, data.bendMagnitude].slice(-sliceLength));
            setVectorAngle((prev) => [...prev, data.vectorAngle].slice(-sliceLength));
            setBaseRoll((prev) => [...prev, data.baseRoll].slice(-sliceLength));
            setBasePitch((prev) => [...prev, data.basePitch].slice(-sliceLength));
            setTopRoll((prev) => [...prev, data.topRoll].slice(-sliceLength));
            setTopPitch((prev) => [...prev, data.topPitch].slice(-sliceLength));
            setTopMinusBaseRoll((prev) => [...prev, data.topMinusBaseRoll].slice(-sliceLength));
            setTopMinusBasePitch((prev) => [...prev, data.topMinusBasePitch].slice(-sliceLength));
        }
    }, [data]);

    useEffect(() => {
        if (lengthSliderRef.current) {
            lengthSliderRef.current.value = displayDataLength.toString();
        }
        if (displayDataLength !== ARRAY_LENGTH) {
            localStorage.setItem("imuDisplayDataLength", displayDataLength.toString());
        }
    }, [displayDataLength]);

    // Send command to IMU node via backend
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
        <div className="mast-monitor">
            {/* Live Status Panel */}
            <Card sx={{ mb: 2 }}>
                <CardContent>
                    <Typography variant="h6" gutterBottom>Mast Monitor - Live</Typography>

                    {/* Primary readings */}
                    <Box sx={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: 2 }}>
                        <AngleDisplay label="Bend Magnitude" value={data?.bendMagnitude ?? null} />
                        <AngleDisplay label="Vector Angle" value={data?.vectorAngle ?? null} />
                        <AngleDisplay label="Top-Base Roll" value={data?.topMinusBaseRoll ?? null} />
                        <AngleDisplay label="Top-Base Pitch" value={data?.topMinusBasePitch ?? null} />
                    </Box>

                    {/* Secondary readings */}
                    <Box sx={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: 2, mt: 2 }}>
                        <AngleDisplay label="Base Roll" value={data?.baseRoll ?? null} />
                        <AngleDisplay label="Base Pitch" value={data?.basePitch ?? null} />
                        <AngleDisplay label="Top Roll" value={data?.topRoll ?? null} />
                        <AngleDisplay label="Top Pitch" value={data?.topPitch ?? null} />
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
                            <Button variant="outlined" size="small" onClick={() => sendCommand("ZERO")}>
                                ZERO
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
                    min={10} max={1000} step={10}
                    valueLabelDisplay="auto"
                    value={displayDataLength}
                    onChange={(_event, value) => setDisplayDataLength(value as number)}
                />
            </Box>

            {/* Charts Over Time */}
            <Grid container spacing={2} columns={12}>
                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Bend Magnitude"
                        lineNames={['Bend']}
                        xAxis={{ xData }}
                        yAxis={{
                            yData: [bendMagnitude],
                            yTitle: "Angle",
                            yUnit: "\u00B0"
                        }}
                    />
                </Grid>

                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Vector Angle"
                        lineNames={['Vector Angle']}
                        xAxis={{ xData }}
                        yAxis={{
                            yData: [vectorAngle],
                            yTitle: "Angle",
                            yUnit: "\u00B0"
                        }}
                    />
                </Grid>

                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Roll Comparison"
                        lineNames={['Base Roll', 'Top Roll', 'Top-Base Roll']}
                        xAxis={{ xData }}
                        yAxis={{
                            yData: [baseRoll, topRoll, topMinusBaseRoll],
                            yTitle: "Roll",
                            yUnit: "\u00B0"
                        }}
                    />
                </Grid>

                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Pitch Comparison"
                        lineNames={['Base Pitch', 'Top Pitch', 'Top-Base Pitch']}
                        xAxis={{ xData }}
                        yAxis={{
                            yData: [basePitch, topPitch, topMinusBasePitch],
                            yTitle: "Pitch",
                            yUnit: "\u00B0"
                        }}
                    />
                </Grid>
            </Grid>
        </div>
    );
}
