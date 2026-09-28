import logo from '../../../public/logo.png';
import Avatar from '@mui/material/Avatar';

export default function CircularIcon() {
    return (
        <Avatar
            src={logo}
            alt="Proa Advisor Logo"
            sx={{ width: 40, height: 40 }}
        />
    )
}