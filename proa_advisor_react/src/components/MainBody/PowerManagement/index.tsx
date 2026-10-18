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
            initialData.forEach((dataPoint) => {
                initialXData.push(dataPoint.total_time);
                initialMainVoltage.push(dataPoint.V_batt_main);
                initialMainSOC.push(dataPoint.SoC_batt_main);
                initialLoadCurrent.push(dataPoint.I_load);
                initialMPPTCurrent.push(dataPoint.I_mppt);
                initialNetMainCurrent.push(dataPoint.I_batt_main);
                initialNetAltCurrent.push(dataPoint.I_batt_alternate);
                initialCorrectedMainVoltage.push(dataPoint.Corrected_V_batt_main);
                initialCorrectedLoadCurrent.push(dataPoint.Corrected_I_load);
                initialCorrectedMPPTCurrent.push(dataPoint.Corrected_I_mppt);
                initialCorrectedNetMainCurrent.push(dataPoint.Corrected_I_batt_main);
                initialCorrectedNetAltCurrent.push(dataPoint.Corrected_I_batt_alternate);
                initialOCVMain.push(dataPoint.OCV_batt_main);
                if (dataPoint.V_batt_alternate) {
                    initialAltVoltage.push(dataPoint.V_batt_alternate);
                }
                if (dataPoint.SoC_batt_alternate) {
                    initialAltSOC.push(dataPoint.SoC_batt_alternate);
                }
                if (dataPoint.Corrected_V_batt_alternate) {
                    initialCorrectedAltVoltage.push(dataPoint.Corrected_V_batt_alternate);
                }
                if (dataPoint.OCV_batt_alternate) {
                    initialOCVAlt.push(dataPoint.OCV_batt_alternate);
                }
            });
            setXData(initialXData.slice(0, defaultLength));
            setVoltageReadingMain(initialMainVoltage.slice(0, defaultLength));
            setSocMain(initialMainSOC.slice(0, defaultLength));
            setCurrentLoad(initialLoadCurrent.slice(0, defaultLength));
            setCurrentMPPT(initialMPPTCurrent.slice(0, defaultLength));
            setCurrentNetMain(initialNetMainCurrent.slice(0, defaultLength));
            setCorrectedVoltageMain(initialCorrectedMainVoltage.slice(0, defaultLength));
            setCorrectedVoltageAlt(initialCorrectedAltVoltage.slice(0, defaultLength));
            setCorrectedCurrentLoad(initialCorrectedLoadCurrent.slice(0, defaultLength));
            setCorrectedCurrentMPPT(initialCorrectedMPPTCurrent.slice(0, defaultLength));
            setCorrectedCurrentNetMain(initialCorrectedNetMainCurrent.slice(0, defaultLength));
            setOCVMain(initialOCVMain.slice(0, defaultLength));
            setOCVAlt(initialOCVAlt.slice(0, defaultLength));
            if (initialAltVoltage.length > 0) {
                setVoltageReadingAlt(initialAltVoltage.slice(0, defaultLength));
            }
            if (initialAltSOC.length > 0) {
                setSocAlt(initialAltSOC.slice(0, defaultLength));
            }
            if (initialNetAltCurrent.length > 0) {
                setCurrentNetAlt(initialNetAltCurrent.slice(0, defaultLength));
            }
            if (initialCorrectedNetAltCurrent.length > 0) {
                setCorrectedCurrentNetAlt(initialCorrectedNetAltCurrent.slice(0, defaultLength));
            }
        }
    }

    useEffect(() => {
        if (data) {
            populateData(data);
        }
    }, [data]);

    function populateData(data: PowerData) {
        const slice_length = parseInt(lengthSliderRef.current?.value || displayDataLength.toString());
        setXData((prevXData) => [...prevXData, data.total_time].slice(-slice_length));
        data.V_batt_main != undefined && setVoltageReadingMain((prev) => [...prev, data.V_batt_main as number].slice(-slice_length));
        data.Corrected_V_batt_main != undefined && setCorrectedVoltageMain((prev) => [...prev, data.Corrected_V_batt_main as number].slice(-slice_length));
        data.OCV_batt_main != undefined && setOCVMain((prev) => [...prev, data.OCV_batt_main as number].slice(-slice_length));
        data.SoC_batt_main != undefined && setSocMain((prev) => [...prev, data.SoC_batt_main as number].slice(-slice_length));
        data.V_batt_alternate != undefined && setVoltageReadingAlt((prev) => [...prev, data.V_batt_alternate as number].slice(-slice_length));
        data.Corrected_V_batt_alternate != undefined && setCorrectedVoltageAlt((prev) => [...prev, data.Corrected_V_batt_alternate as number].slice(-slice_length));
        data.OCV_batt_alternate != undefined && setOCVAlt((prev) => [...prev, data.OCV_batt_alternate as number].slice(-slice_length));
        data.SoC_batt_alternate != undefined && setSocAlt((prev) => [...prev, data.SoC_batt_alternate as number].slice(-slice_length));
        data.I_load != undefined && setCurrentLoad((prev) => [...prev, data.I_load as number].slice(-slice_length));
        data.I_mppt != undefined && setCurrentMPPT((prev) => [...prev, data.I_mppt as number].slice(-slice_length));
        data.I_batt_main != undefined && setCurrentNetMain((prev) => [...prev, data.I_batt_main as number].slice(-slice_length));
        data.I_batt_alternate != undefined && setCurrentNetAlt((prev) => [...prev, data.I_batt_alternate as number].slice(-slice_length));
        data.Corrected_I_load != undefined && setCorrectedCurrentLoad((prev) => [...prev, data.Corrected_I_load as number].slice(-slice_length));
        data.Corrected_I_mppt != undefined && setCorrectedCurrentMPPT((prev) => [...prev, data.Corrected_I_mppt as number].slice(-slice_length));
        data.Corrected_I_batt_main != undefined && setCorrectedCurrentNetMain((prev) => [...prev, data.Corrected_I_batt_main as number].slice(-slice_length));
        data.Corrected_I_batt_alternate != undefined && setCorrectedCurrentNetAlt((prev) => [...prev, data.Corrected_I_batt_alternate as number].slice(-slice_length));
    };

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

                {voltageReadingAlt.length != 0 && voltageReadingAlt[0] !== undefined && (
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

                {voltageReadingAlt.length != 0 && voltageReadingAlt[0] !== undefined && (
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

                {voltageReadingAlt.length != 0 && voltageReadingAlt[0] !== undefined && (
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