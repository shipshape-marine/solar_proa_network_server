import type { } from '@mui/x-date-pickers/themeAugmentation';
import type { } from '@mui/x-charts/themeAugmentation';
import type { } from '@mui/x-data-grid-pro/themeAugmentation';
import type { } from '@mui/x-tree-view/themeAugmentation';
import { alpha } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import AppNavbar from './components/NavBar/AppNavbar';
import Header from './components/Header/Header';
import SideMenu from './components/Sidebar/SideMenu';
import AppTheme from './theme/AppTheme';
import {
    chartsCustomizations,
    dataGridCustomizations,
    datePickersCustomizations,
    treeViewCustomizations,
} from './theme/customizations';
import { lazy, Suspense, useEffect, useState } from 'react';
import Overview from './components/MainBody/Overview';
import PowerManagement from './components/MainBody/PowerManagement';
import StrainManagement from './components/MainBody/StrainManagement';
import MastMonitor from './components/MainBody/MastMonitor';
import DevPanel from './components/Dev Panel';
import MessageBlock from './components/FloatingMessage/MessageBlock';
import './data_type/message';
import './data_type/power';
import './data_type/imu';
import './data_type/strain';
import './data_type/gps';

const GpsMap = lazy(() => import('./components/MainBody/GpsMap'));

const xThemeComponents = {
    ...chartsCustomizations,
    ...dataGridCustomizations,
    ...datePickersCustomizations,
    ...treeViewCustomizations,
};

export default function Dashboard(props: { disableCustomTheme?: boolean }) {
    const [mainContent, setMainContent] = useState(0);
    const [powerData, setPowerData] = useState<PowerData | null>(null);
    const [messages, setMessages] = useState<MessageData[]>([]);  // For floating messages
    const [strainData, setStrainData] = useState<StrainData | null>(null);
    const [imuData, setImuData] = useState<IMUData | null>(null);
    const [gpsData, setGpsData] = useState<GPSData | null>(null);
    const [gpsTrack, setGpsTrack] = useState<GPSData[]>([]);

    useEffect(() => {
        let eventSource: EventSource | null = null;
        eventSource = new EventSource("/data_stream");
        eventSource.onopen = () => {
            handleMessageEvent(eventSource!);
        }
        eventSource.onerror = (error) => {
            console.error("EventSource failed, falling back to localhost:", error);
            eventSource?.close();
            eventSource = new EventSource("http://localhost:4000/data_stream");
            handleMessageEvent(eventSource);
        }

        return () => {
            eventSource?.close();
        };
    }, []);

    function handleMessageEvent(eventSource: EventSource) {
        eventSource.onopen = () => {
            console.log("Connected to data stream");
        }
        
        eventSource.addEventListener("power", (event) => {
            const data = JSON.parse(event.data);
            setPowerData(data);
        });

        eventSource.addEventListener("strain", (event) => {
            const data = JSON.parse(event.data);
            setStrainData(data);
        });

        eventSource.addEventListener("imu", (event) => {
            const data = JSON.parse(event.data);
            setImuData(data);
        });

        eventSource.addEventListener("gps", (event) => {
            const data: GPSData = JSON.parse(event.data);
            setGpsData(data);
            if (data.valid) {
                setGpsTrack((previous) => {
                    if (previous.some((point) => point.counter === data.counter)) {
                        return previous;
                    }
                    return [...previous, data].slice(-10000);
                });
            }
        });

        eventSource.addEventListener("message", (event) => {
            const data = JSON.parse(event.data);
            setMessages((prevMessages) => [...prevMessages, data]);
        });
    }

    return (
        <AppTheme {...props} themeComponents={xThemeComponents}>
            <CssBaseline enableColorScheme />
            <Box sx={{ display: 'flex', width: '100%' }}>
                <Box >
                    <SideMenu selectedContent={mainContent} setSelectContent={setMainContent} />
                    <AppNavbar selectedContent={mainContent} setSelectContent={setMainContent} />
                </Box>
                <Box
                    component="main"
                    sx={(theme) => ({
                        flexGrow: 1,
                        backgroundColor: theme.vars
                            ? `rgba(${theme.vars.palette.background.defaultChannel} / 1)`
                            : alpha(theme.palette.background.default, 1),
                        overflow: 'auto',
                    })}
                >
                    <Stack
                        spacing={2}
                        sx={{
                            alignItems: 'center',
                            mx: 3,
                            pb: 5,
                            mt: { xs: 8, md: 0 },
                        }}

                    >

                        <Header currentTab=
                            {mainContent === -1 ? 'Template Layout' :
                                mainContent === 0 ? 'Overview' :
                                    mainContent === 1 ? 'Power Management' :
                                        mainContent === 2 ? 'Strain Management' :
                                            mainContent === 3 ? 'Mast Monitor' :
                                                mainContent === 4 ? 'GPS Route' :
                                                    mainContent === 5 ? 'Dev Panel' :
                                            'Unknown'} />
                        <MessageBlock Messages={messages} />
                        <Stack sx={{ width: "100%", height: "100%" }}>
                            {mainContent === 0 ? <Overview powerData={powerData} strainData={strainData} /> :
                                    mainContent === 1 ? <PowerManagement data={powerData} /> :
                                        mainContent === 2 ? <StrainManagement data={strainData} /> :
                                            mainContent === 3 ? <MastMonitor data={imuData} /> :
                                                mainContent === 4 ? (
                                                    <Suspense fallback={<Box sx={{ width: '100%', minHeight: 400 }}>Loading map...</Box>}>
                                                        <GpsMap data={gpsData} track={gpsTrack} />
                                                    </Suspense>
                                                ) :
                                                    mainContent === 5 ? <DevPanel /> :
                                        <div>Unknown Content</div>
                            }
                        </Stack>
                    </Stack>
                </Box>
            </Box>
        </AppTheme>
    );
}
