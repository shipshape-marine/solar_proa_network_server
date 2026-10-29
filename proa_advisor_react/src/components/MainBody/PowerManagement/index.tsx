import { useEffect, useRef, useState } from "react";
import DynamicLineChart from "../../Chart/DynamicLineChart";
import Grid from '@mui/material/Grid';
import Slider from "@mui/material/Slider";
import Box from '@mui/material/Box';
import "../../../data_type/power"

/* Charts:
1. Voltage Main (actual vs corrected)
2. Voltage Alt (actual vs corrected)
3. SOC Main and Alt
4. Current Load, MPPT, Net Main, Net Alt (actual vs corrected)
*/

const ARRAY_LENGTH = 5000;

export default function PowerManagement({data}: {data: PowerData | null}) {
    const [xData, setXData] = useState<number[]>([]);

    const [voltageReadingMain, setVoltageReadingMain] = useState<number[]>([]);
    const [voltageReadingAlt, setVoltageReadingAlt] = useState<number[]>([]);
    const [OCVMain, setOCVMain] = useState<number[]>([]);
    const [correctedVoltageMain, setCorrectedVoltageMain] = useState<number[]>([]);
    const [correctedVoltageAlt, setCorrectedVoltageAlt] = useState<number[]>([]);
    const [OCVAlt, setOCVAlt] = useState<number[]>([]);

    const [socMain, setSocMain] = useState<number[]>([]);
    const [socAlt, setSocAlt] = useState<number[]>([]);

    const [currentLoad, setCurrentLoad] = useState<number[]>([]);
    const [currentMPPT, setCurrentMPPT] = useState<number[]>([]);
    const [currentNetMain, setCurrentNetMain] = useState<number[]>([]);
    const [currentNetAlt, setCurrentNetAlt] = useState<number[]>([]);
    const [correctedCurrentLoad, setCorrectedCurrentLoad] = useState<number[]>([]);
    const [correctedCurrentMPPT, setCorrectedCurrentMPPT] = useState<number[]>([]);
    const [correctedCurrentNetMain, setCorrectedCurrentNetMain] = useState<number[]>([]);
    const [correctedCurrentNetAlt, setCorrectedCurrentNetAlt] = useState<number[]>([]);

    const [displayDataLength, setDisplayDataLength] = useState<number>(ARRAY_LENGTH);
    const lengthSliderRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        // If xData is empty, fetch initial data to pupulate
        if (xData.length === 0) {
            const fetchInitialData = async () => {
                try {
                    const response = await fetch("/initial_power_data");
                    const initialData: PowerData[] = await response.json();
                    updateInitialData(initialData);
                } catch (error) {
                    console.log("Falling back to localhost for initial data fetch.");
                    try {
                        const response = await fetch("http://localhost:4000/initial_power_data");
                        const initialData: PowerData[] = await response.json();
                        updateInitialData(initialData);
                    } catch (error) {
                        console.error("Fallback fetch failed:", error);
                    }
                }
            };
            fetchInitialData();
        }
    }, []);

    function updateInitialData(initialData: PowerData[]) {
        let defaultLength = ARRAY_LENGTH;
        if (localStorage.getItem("displayDataLength")) {
            defaultLength = parseInt(localStorage.getItem("displayDataLength") || "");
            setDisplayDataLength(defaultLength);
        }
        if (initialData && initialData.length > 0) {
            const initialMainVoltage: number[] = []; const initialAltVoltage: number[] = []; const initialMainSOC: number[] = []; const initialAltSOC: number[] = [];
            const initialLoadCurrent: number[] = []; const initialMPPTCurrent: number[] = []; const initialNetMainCurrent: number[] = []; const initialNetAltCurrent: number[] = [];
            const initialCorrectedMainVoltage: number[] = []; const initialCorrectedAltVoltage: number[] = [];
            const initialCorrectedLoadCurrent: number[] = []; const initialCorrectedMPPTCurrent: number[] = []; const initialCorrectedNetMainCurrent: number[] = []; const initialCorrectedNetAltCurrent: number[] = [];
            const initialOCVMain: number[] = []; const initialOCVAlt: number[] = [];
            const initialXData: number[] = [];
            // Push a value for every row (NaN = gap) so each series stays index-aligned
            // with xData; skipping missing values would shift later points in time.
            initialData.forEach((dataPoint) => {
                initialXData.push(dataPoint.total_time);
                initialMainVoltage.push(dataPoint.V_batt_main ?? NaN);
                initialMainSOC.push(dataPoint.SoC_batt_main ?? NaN);
                initialLoadCurrent.push(dataPoint.I_load ?? NaN);
                initialMPPTCurrent.push(dataPoint.I_mppt ?? NaN);
                initialNetMainCurrent.push(dataPoint.I_batt_main ?? NaN);
                initialNetAltCurrent.push(dataPoint.I_batt_alternate ?? NaN);
                initialCorrectedMainVoltage.push(dataPoint.Corrected_V_batt_main ?? NaN);
                initialCorrectedLoadCurrent.push(dataPoint.Corrected_I_load ?? NaN);
                initialCorrectedMPPTCurrent.push(dataPoint.Corrected_I_mppt ?? NaN);
                initialCorrectedNetMainCurrent.push(dataPoint.Corrected_I_batt_main ?? NaN);
                initialCorrectedNetAltCurrent.push(dataPoint.Corrected_I_batt_alternate ?? NaN);
                initialOCVMain.push(dataPoint.OCV_batt_main ?? NaN);
                initialAltVoltage.push(dataPoint.V_batt_alternate ?? NaN);
                initialAltSOC.push(dataPoint.SoC_batt_alternate ?? NaN);
                initialCorrectedAltVoltage.push(dataPoint.Corrected_V_batt_alternate ?? NaN);
                initialOCVAlt.push(dataPoint.OCV_batt_alternate ?? NaN);
            });
            // Keep the newest points, matching how live data trims with slice(-n)
            setXData(initialXData.slice(-defaultLength));
            setVoltageReadingMain(initialMainVoltage.slice(-defaultLength));
            setSocMain(initialMainSOC.slice(-defaultLength));
            setCurrentLoad(initialLoadCurrent.slice(-defaultLength));
            setCurrentMPPT(initialMPPTCurrent.slice(-defaultLength));
            setCurrentNetMain(initialNetMainCurrent.slice(-defaultLength));
            setCorrectedVoltageMain(initialCorrectedMainVoltage.slice(-defaultLength));
            setCorrectedVoltageAlt(initialCorrectedAltVoltage.slice(-defaultLength));
            setCorrectedCurrentLoad(initialCorrectedLoadCurrent.slice(-defaultLength));
            setCorrectedCurrentMPPT(initialCorrectedMPPTCurrent.slice(-defaultLength));
            setCorrectedCurrentNetMain(initialCorrectedNetMainCurrent.slice(-defaultLength));
            setOCVMain(initialOCVMain.slice(-defaultLength));
            setOCVAlt(initialOCVAlt.slice(-defaultLength));
            setVoltageReadingAlt(initialAltVoltage.slice(-defaultLength));
            setSocAlt(initialAltSOC.slice(-defaultLength));
            setCurrentNetAlt(initialNetAltCurrent.slice(-defaultLength));
            setCorrectedCurrentNetAlt(initialCorrectedNetAltCurrent.slice(-defaultLength));
        }
    }

    useEffect(() => {
        if (data) {
            populateData(data);
        }
    }, [data]);

    function populateData(data: PowerData) {
        const slice_length = parseInt(lengthSliderRef.current?.value || displayDataLength.toString());
        // Always append (NaN = gap) so every series stays index-aligned with xData
        const append = (value: number | null | undefined) => (prev: number[]) => [...prev, value ?? NaN].slice(-slice_length);
        setXData((prevXData) => [...prevXData, data.total_time].slice(-slice_length));
        setVoltageReadingMain(append(data.V_batt_main));
        setCorrectedVoltageMain(append(data.Corrected_V_batt_main));
        setOCVMain(append(data.OCV_batt_main));
        setSocMain(append(data.SoC_batt_main));
        setVoltageReadingAlt(append(data.V_batt_alternate));
        setCorrectedVoltageAlt(append(data.Corrected_V_batt_alternate));
        setOCVAlt(append(data.OCV_batt_alternate));
        setSocAlt(append(data.SoC_batt_alternate));
        setCurrentLoad(append(data.I_load));
        setCurrentMPPT(append(data.I_mppt));
        setCurrentNetMain(append(data.I_batt_main));
        setCurrentNetAlt(append(data.I_batt_alternate));
        setCorrectedCurrentLoad(append(data.Corrected_I_load));
        setCorrectedCurrentMPPT(append(data.Corrected_I_mppt));
        setCorrectedCurrentNetMain(append(data.Corrected_I_batt_main));
        setCorrectedCurrentNetAlt(append(data.Corrected_I_batt_alternate));
    };

    // Alt series are now NaN-padded, so show the alt charts only once a real reading exists
    const hasAltBattery = voltageReadingAlt.some(Number.isFinite);

    useEffect(() => {
        if (lengthSliderRef.current) {
            lengthSliderRef.current.value = displayDataLength.toString();
        }
        if (displayDataLength === 500) return
        localStorage.setItem("displayDataLength", displayDataLength.toString());
    }, [displayDataLength]);

    return (
        <div className="power-management">
            <Box sx={{ width: 300 }}>
                <p>Number of points: {displayDataLength}</p>
                <Slider 
                    ref={lengthSliderRef}
                    min={5} max={5000} step={5} 
                    valueLabelDisplay="auto" 
                    value={displayDataLength} 
                    onChange={(event, value) => setDisplayDataLength(value)} />
            </Box>

            <Grid container spacing={2} columns={12}>

                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Main Battery Voltage"
                        lineNames={['Actual', 'Corrected', 'OCV']}
                        xAxis={
                            { xData: xData }
                        }
                        yAxis={
                            {
                                yData: [voltageReadingMain, correctedVoltageMain, OCVMain],
                                yTitle: "Voltage",
                                yUnit: "V"
                            }
                        }
                    />
                </Grid>

                {hasAltBattery && (
                    <Grid size={{ xs: 12, lg: 6 }}>
                        <DynamicLineChart
                            title="Alt Battery Voltage"
                            lineNames={['Actual', 'Corrected', 'OCV']}
                            xAxis={
                                { xData: xData }
                            }
                            yAxis={
                                {
                                    yData: [voltageReadingAlt, correctedVoltageAlt, OCVAlt],
                                    yTitle: "Voltage",
                                    yUnit: "V"
                                }
                            }
                        />
                    </Grid>
                )}

                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Main Battery SOC"
                        lineNames={['SOC']}
                        xAxis={
                            { xData: xData }
                        }
                        yAxis={
                            {
                                yData: [socMain],
                                yTitle: "State of Charge",
                                yUnit: "%",
                                yFixed: false,
                                significantDigits: 3
                            }
                        }
                    />
                </Grid>

                {hasAltBattery && (
                    <Grid size={{ xs: 12, lg: 6 }}>
                        <DynamicLineChart
                            title="Alt Battery SOC"
                            lineNames={['SOC']}
                            xAxis={
                                { xData: xData }
                            }
                            yAxis={
                                {
                                    yData: [socAlt],
                                    yTitle: "State of Charge",
                                    yUnit: "%",
                                    yFixed: false,
                                    significantDigits: 3
                                }
                            }
                        />
                    </Grid>
                )}

                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Current Load"
                        lineNames={['Actual', 'Corrected']}
                        xAxis={
                            { xData: xData }
                        }
                        yAxis={
                            {
                                yData: [currentLoad, correctedCurrentLoad],
                                yTitle: "Current",
                                yUnit: "A"
                            }
                        }
                    />
                </Grid>

                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Current MPPT"
                        lineNames={['Actual', 'Corrected']}
                        xAxis={
                            { xData: xData }
                        }
                        yAxis={
                            {
                                yData: [currentMPPT, correctedCurrentMPPT],
                                yTitle: "Current",
                                yUnit: "A"
                            }
                        }
                    />
                </Grid>

                <Grid size={{ xs: 12, lg: 6 }}>
                    <DynamicLineChart
                        title="Current Net Main"
                        lineNames={['Actual', 'Corrected']}
                        xAxis={
                            { xData: xData }
                        }
                        yAxis={
                            {
                                yData: [currentNetMain, correctedCurrentNetMain],
                                yTitle: "Current",
                                yUnit: "A"
                            }
                        }
                    />
                </Grid>

                {hasAltBattery && (
                    <Grid size={{ xs: 12, lg: 6 }}>
                        <DynamicLineChart
                            title="Current Net Alt"
                            lineNames={['Actual', 'Corrected']}
                            xAxis={
                                { xData: xData }
                            }
                            yAxis={
                                {
                                    yData: [currentNetAlt, correctedCurrentNetAlt],
                                    yTitle: "Current",
                                    yUnit: "A"
                                }
                            }
                        />
                    </Grid>
                )}
            </Grid>
        </div>
    );
}