import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import HomeRoundedIcon from '@mui/icons-material/HomeRounded';
import AnalyticsRoundedIcon from '@mui/icons-material/AnalyticsRounded';
import PeopleRoundedIcon from '@mui/icons-material/PeopleRounded';
import ImportantDevicesIcon from '@mui/icons-material/ImportantDevices';
import StraightenIcon from '@mui/icons-material/Straighten';
import MapRoundedIcon from '@mui/icons-material/MapRounded';

const mainListItems = [
    { text: 'Overview', icon: <HomeRoundedIcon /> },
    { text: 'Power Management', icon: <AnalyticsRoundedIcon /> },
    { text: 'Strain Gauge', icon: <PeopleRoundedIcon /> },
    { text: 'Mast Monitor', icon: <StraightenIcon /> },
    { text: 'GPS Route', icon: <MapRoundedIcon /> },
];

const secondaryListItems = [
    { text: 'Dev Panel', icon: <ImportantDevicesIcon /> },
];

export default function MenuContent({ selectedContent, setSelectContent }) {
    const selectedIndex = selectedContent ?? 0;

    // Secondary list items will be off set by main content to simplify switching and highlighting tab
    function handleSelect(index) { 
        setSelectContent(index);
    }

    return (
        <Stack sx={{ flexGrow: 1, p: 1, justifyContent: 'space-between' }}>
            <List dense>
                {mainListItems.map((item, index) => (
                    <ListItem key={index} disablePadding sx={{ display: 'block' }}>
                        <ListItemButton selected={index === selectedIndex} onClick={() => handleSelect(index)}>
                            <ListItemIcon>{item.icon}</ListItemIcon>
                            <ListItemText primary={item.text} />
                        </ListItemButton>
                    </ListItem>
                ))}
            </List>
            <List dense>
                {secondaryListItems.map((item, index) => (
                    <ListItem key={index} disablePadding sx={{ display: 'block' }}>
                        <ListItemButton selected={index + mainListItems.length === selectedIndex} onClick={() => handleSelect(index + mainListItems.length)}>
                            <ListItemIcon>{item.icon}</ListItemIcon>
                            <ListItemText primary={item.text} />
                        </ListItemButton>
                    </ListItem>
                ))}
            </List>
        </Stack>
    );
}
