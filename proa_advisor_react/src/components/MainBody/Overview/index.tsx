import BatteryGauge from 'react-battery-gauge'
import "../../../data_type/power"
import { useEffect, useRef } from 'react';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';

const CALCULATE_INTERVAL = 1000;
const MAX_TIME_BEFORE_HIDE = 20 * 60 * 60; // Hours in seconds
type IntervalUpdateProps = {
    batt1Percent: number;
    batt2Percent: number | null;
    prevBatt1Percent: number;
    prevBatt2Percent: number;
    batt1RemainingTime: number;
    batt2RemainingTime: number;
}

export default function Overview({ powerData, strainData }: { powerData: PowerData | null, strainData: any }) {
    const powerDataRef = useRef<PowerData | null>(powerData);
    const updateIntervalRef = useRef<IntervalUpdateProps>({ batt1Percent: 0, batt2Percent: null, prevBatt1Percent: 0, prevBatt2Percent: 0, batt1RemainingTime: 0, batt2RemainingTime: 0 });

    useEffect(() => {
        if (powerData) {
            powerDataRef.current = powerData;
            updateIntervalRef.current.batt1Percent = powerData.SoC_batt_main;
            updateIntervalRef.current.batt2Percent = powerData.SoC_batt_alternate !== undefined ? powerData.SoC_batt_alternate : null;
        }
    }, [powerData]);

    useEffect(() => {
        const interval = setInterval(() => {
            calculateRemainingTime();
        }, CALCULATE_INTERVAL);

        return () => clearInterval(interval);
    }, []);

    function calculateRemainingTime() {
        if (updateIntervalRef.current.batt1RemainingTime == 9999999) {
            updateIntervalRef.current.batt1RemainingTime = 0;
        }
        if (updateIntervalRef.current.batt2RemainingTime == 9999999) {
            updateIntervalRef.current.batt2RemainingTime = 0;
        }
        let firstRun = false;
        if (updateIntervalRef.current) {
            if (updateIntervalRef.current.prevBatt1Percent == 0) {
                firstRun = true;
                updateIntervalRef.current.prevBatt1Percent = updateIntervalRef.current.batt1Percent;
            }
            if (updateIntervalRef.current.batt2Percent !== null && updateIntervalRef.current.prevBatt2Percent == 0) {
                firstRun = true;
                updateIntervalRef.current.prevBatt2Percent = updateIntervalRef.current.batt2Percent;
            }
        }
        if (firstRun) return;
        if (!updateIntervalRef.current) return;
        let batt1Difference = updateIntervalRef.current.batt1Percent - updateIntervalRef.current.prevBatt1Percent;
        if (Math.abs(batt1Difference) < 1e-5) batt1Difference = 0; // Avoid division by zero
        let batt1RemainingTime = batt1Difference !== 0 ? (CALCULATE_INTERVAL / 1000) * (batt1Difference < 0 ? updateIntervalRef.current.batt1Percent : (100 - updateIntervalRef.current.batt1Percent)) / batt1Difference : 9999999;
        if (powerDataRef.current && Math.abs(powerDataRef.current.I_batt_main) < 0.1) {
            // If the battery is not discharging, set remaining time to a large number
            // From residual value of corrected ocv recovering after a circuit open
            batt1RemainingTime = 9999999; // If the battery is not discharging, set remaining time to a large number
        }
        updateIntervalRef.current.batt1RemainingTime = batt1RemainingTime;
        updateIntervalRef.current.prevBatt1Percent = updateIntervalRef.current.batt1Percent;
        if (updateIntervalRef.current.batt2Percent !== null && updateIntervalRef.current.prevBatt2Percent !== null) {
            let batt2Difference = updateIntervalRef.current.batt2Percent - updateIntervalRef.current.prevBatt2Percent;
            if (Math.abs(batt2Difference) < 1e-5) batt2Difference = 0; // Avoid division by zero
            let batt2RemainingTime = batt2Difference !== 0 ? (CALCULATE_INTERVAL / 1000) * (batt2Difference < 0 ? updateIntervalRef.current.batt2Percent : (100 - updateIntervalRef.current.batt2Percent)) / batt2Difference : 9999999;
            if (powerDataRef.current && Math.abs(powerDataRef.current.I_batt_alternate) < 0.1) {
                batt2RemainingTime = 9999999;
            }
            updateIntervalRef.current.batt2RemainingTime = batt2RemainingTime;
            updateIntervalRef.current.prevBatt2Percent = updateIntervalRef.current.batt2Percent;
        }
    }

    function formatTime(seconds: number): string {
        seconds = Math.abs(seconds); // Ensure seconds is positive
        if (seconds == 0 || seconds > MAX_TIME_BEFORE_HIDE) {
            return "Loading...";
        }
        if (seconds < 60) {
            return `${seconds.toFixed(2)} s`;
        } else if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${minutes} min ${remainingSeconds.toFixed(0)} s`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const remainingMinutes = Math.floor((seconds % 3600) / 60);
            return `${hours} hr ${remainingMinutes.toFixed(0)} min`;
        }
    }

    // Power data to display:
    // summary list of total Wh for mppt, load, b1 and b2 in a card
    // battery guage for b1 and b2 + remaining time left below each in a card
    return (
        <div className="overview">
            <Grid container spacing={2} columns={12} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
                <Grid size={{ xs: 12, md: 6 }}>
                    <Card variant="outlined" sx={{ width: '100%' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                            <thead>
                                <tr style={{ textAlign: 'center' }}>
                                    <td colSpan={2}>
                                        Power Summary
                                    </td>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>Total Time Elapsed:</td>
                                    <td><div>{formatTime(powerDataRef.current?.total_time || 0)}</div></td>
                                </tr>
                                <tr>
                                    <td>Total MPPT Energy:</td>
                                    <td>{powerDataRef.current?.total_mppt_W !== undefined ? (powerDataRef.current.total_mppt_W / 3600).toFixed(2) : "0.00"} Wh</td>
                                </tr>
                                <tr>
                                    <td>Total Load Energy:</td>
                                    <td>{powerDataRef.current?.total_load_W !== undefined ? (powerDataRef.current.total_load_W / 3600).toFixed(2) : "0.00"} Wh</td>
                                </tr>
                                <tr>
                                    <td>Total Battery 1 Net Output:</td>
                                    <td>{powerDataRef.current?.total_batt1_net_W !== undefined ? (powerDataRef.current.total_batt1_net_W / 3600).toFixed(2) : "0.00"} Wh</td>
                                </tr>
                                {powerDataRef.current?.total_batt2_net_W !== undefined && (
                                    <tr>
                                        <td>Total Battery 2 Net Output:</td>
                                        <td>{(powerDataRef.current.total_batt2_net_W / 3600).toFixed(2)} Wh</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </Card>
                </Grid>
                <Grid size={{ xs: 12, md: 6 }} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <Card variant="outlined" sx={{ width: '100%' }}>
                        <h3>Battery Status</h3>
                        <div style={{ display: 'flex', gap: '20px', justifyContent: 'center', flexDirection: 'column' }}>
                            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'row', justifyContent: 'left', marginLeft: '30%', gap: '20px', alignItems: 'center' }}>
                                <BatteryGauge size={100} orientation="horizontal" aspectRatio={0.56} animated={false} value={updateIntervalRef.current !== null ? updateIntervalRef.current.batt1Percent : 0}
                                    formatValue={(v) => updateIntervalRef.current !== null ? updateIntervalRef.current.batt1Percent?.toFixed(2) : "0.000"}
                                    customization={{
                                        readingText: { lightContrastColor: '#676767', darkContrastColor: '#e7e7e7' },
                                        batteryMeter: { lowBatteryValue: 25, lowBatteryFill: 'red', noOfCells: 1 },
                                        batteryBody: { strokeColor: '#676767' }, batteryCap: { strokeColor: '#676767' }
                                    }} />
                                <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left', marginLeft: '10px' }}>
                                    <div>Battery 1</div>
                                    <div>
                                        To {updateIntervalRef.current?.batt1RemainingTime > 0 ? "Full" : "Empty"}: {formatTime(updateIntervalRef.current?.batt1RemainingTime)}
                                    </div>
                                </div>
                            </div>
                            {updateIntervalRef.current !== null && updateIntervalRef.current.batt2Percent !== null && (
                                <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'row', justifyContent: 'left', marginLeft: '30%', gap: '20px' }}>
                                    <BatteryGauge size={100} orientation="horizontal" aspectRatio={0.56} animated={false} value={updateIntervalRef.current !== null ? updateIntervalRef.current.batt2Percent : 0}
                                        formatValue={(v) => updateIntervalRef.current !== null && updateIntervalRef.current.batt2Percent !== null ? updateIntervalRef.current.batt2Percent.toFixed(2) : "0.000"}
                                        customization={{
                                            readingText: { lightContrastColor: '#676767', darkContrastColor: '#e7e7e7' },
                                            batteryMeter: { lowBatteryValue: 25, lowBatteryFill: 'red', noOfCells: 1 },
                                            batteryBody: { strokeColor: '#676767' }, batteryCap: { strokeColor: '#676767' }
                                        }} />
                                    <div style={{ display: 'flex', flexDirection: 'column', textAlign: 'left', marginLeft: '10px' }}>
                                        <div>Battery 2</div>
                                        <div>To {updateIntervalRef.current?.batt2RemainingTime > 0 ? "Full" : "Empty"}: {formatTime(updateIntervalRef.current?.batt2RemainingTime)}</div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </Card>
                </Grid>
            </Grid>
        </div>
    );
}