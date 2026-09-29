# Table of Contents
- [Hardware](#hardware)
  - [Electrical Simulation and Validation](#electrical-simulation-and-validation)
  - [PCB Printing and Assembly](#pcb-printing-and-assembly)
- [Framework](#framework)
  - [Microcontroller Modules](#microcontroller-modules)
  - [Communication Protocols Choice](#communication-protocols-choice)
  - [Network Visualization](#network-visualization)
- [Technology Stack](#technology-stack)
  - [Frontend & Backend Communication](#frontend--backend-communication)
- [Backend Structure](#backend-structure)
  - [Folder Structure](#folder-structure)
  - [Steps to Add New Data Stream Handler](#steps-to-add-new-data-stream-handler)
- [Frontend Structure](#frontend-structure)
  - [Steps to add new tabs](#steps-to-add-new-tabs)
  - [Dev panel control](#dev-panel-control)
- [Setup Guide](#raspberry-pi-4-setup)
  - [Part 1: Running the App](#part-1-running-the-app)
  - [Part 2: Raspberry Pi 4 Setup (Everything else after this is for setting up on raspberry pi)](#part-2-raspberry-pi-4-setup-everything-else-after-this-is-for-setting-up-on-raspberry-pi)
    - [2.1 Initial Setup (from a fresh install via Raspberry Pi Imager)](#21-initial-setup-from-a-fresh-install-via-raspberry-pi-imager)
    - [2.2 SSH into the Pi from Another Computer](#22-ssh-into-the-pi-from-another-computer)
    - [2.3 Optimize Boot Time](#23-optimize-boot-time)
    - [2.4 Verify Network Connectivity (Before Upgrading Packages)](#24-verify-network-connectivity-before-upgrading-packages)
    - [2.5 Download Required Packages](#25-download-required-packages)
    - [2.6 Set Up the Git Repo](#26-set-up-the-git-repo)
    - [2.7 Set Up the Network (Wi-Fi Access Point)](#27-set-up-the-network-wi-fi-access-point)
    - [2.8 Set Up Auto-Start on Boot](#28-set-up-auto-start-on-boot)
    - [2.9 Auto-Redirect Port 80 to the App (Port 4000)](#29-auto-redirect-port-80-to-the-app-port-4000)
    - [2.10 Note: AP vs. Wi-Fi Receiver Mode](#210-note-ap-vs-wi-fi-receiver-mode)
- [Final Notes](#final-notes)


# Hardware

ESP32 microcontrollers is chosed for its low cost, low power consumption, and ease of use. It is also widely supported by the Arduino IDE and has a large community for support.

In comparison:
- Arduino: Low cost, low power consumption but large in size and limited in processing power.
- STM32: Low cost, low power consumption, but requires more complex setup and programming.
- Raspberry Pi: High processing power, but high cost and power consumption. Not suitable for low power applications.

Instead, ESP32 will be used as the main high speed sensor reading and collection node, while a single Raspberry Pi will be used as a local server for data processing, visualization and device control.

## Electrical Simulation and Validation
Simulation workflow can be found at [Solar Proa](https://github.com/shipshape-marine/solar-proa/tree/main/src/electrical_simulation).

Simulation and validation is done on a parameterised model of the electrical system, with a simple configuration file to change the parameter of the system (panel & battery array setup, component specifications, etc.) to simulate different scenarios and validate the system design.

[![Proa Local Server Network Schema](./images/Final%20Build/Full%20Electrical%20Build.png)](./images/Final%20Build/)

## PCB Printing and Assembly 

For power management board - ESP32 C3 + ADS8688 only

KiCad build file [here](./Hardware%20Schematics/ADC%20Power%20Sensor%20Design/).

BOM file might be outdated. KiCad or other PCB design software often have plugins to query available components and prices from PCB manufacturers (e.g. JLCPCB). Please check with your PCB manufacturer for the latest prices and availability.

[![Power Management Board](./images/Power%20Management%20PCB/ADS8688%20Reader.png)](./images/Power%20Management%20PCB/)


# Framework

Network of ESP32 microcontrollers with a Raspberry Pi 4 acting as a local server. ESP32 reading the sensors (slave) communicates bi-directionally via ESP-NOW where the main (Master) ESP32 sends the data to the raspberry pi via Serial communication.

## Microcontroller Modules

| Purpose | Module | External Module | 
|---|---|---|
| Main power data collection | ESP32 C3 | ADS8688 16-bit ADC |
| IMU data collection | Seeed NRF52840 sense | Integrated IMU |
| Strain data collection | ESP32 WROOM-32D | NAU7802 24-bit ADC |
| Auxiliary power data collection | - | INA219 Shunt |
| GPS data collection | - | ATGM336H |
| Intermediate data collection | ESP32 C3 | GPS + Shunt + IMU (BLE) |

## Communication Protocols Choice
ESP-NOW used for its low latency and low power consumption while being very easy to setup (<10 lines to setup + 2 function that runs when receiving or sending data), while Serial is used for its reliability and ease of use.

| Protocol | Latency | Power Consumption | Range | Hardware Requirement | Setup Complexity | Compatibility |
|---|---|---|---|---|---|---|
| WiFi | 🟡 Medium–High | 🔴 High | 🟡 Medium (50 - 100 m) | 🟢 Most ESP modules  | 🟢 Easy | 🟢 Wide |
| Bluetooth Classic | 🟡 Low–Medium | 🟡 Medium | 🔴 Short (10 m) | 🟢 Most ESP modules | 🟡 Medium | 🟢 Wide |
| Bluetooth Low Energy (BLE) | 🟢 Low | 🟢 Very Low | 🔴 Short (10 m) | 🟢 Built-in on many ESP modules | 🟡 Medium–High | 🟢 Wide |
| ESP-NOW | 🟢 Very Low | 🟡 Low–Medium | 🟡 Medium (50 - 100 m) | 🟢 ESP Family device (with on board WiFi) | 🟢 Very Easy | 🔴 ESP only |
| LoRa / LoRaWAN | 🔴 Medium–High | 🟢 Very Low | 🟢 Very Long (2 - 15 km)| 🔴 Requires external LoRa module | 🟡 Medium | 🟡 MCU independent |
| Zigbee | 🟢 Low–Medium | 🟢 Low | 🟡 Medium (10 - 100 m) | 🟡 Requires Zigbee radio module | 🟡 Medium | 🟡 Zigbee ecosystem |
| Thread | 🟢 Low | 🟢 Low | 🟡 Medium (10 - 50 m) | 🔴 Requires Thread-capable radio | 🟡 Medium–High | 🟡 Thread / Matter ecosystem |

Given that the vessel spans 10 - 13 m in length, and the ESP32s are placed at different locations on the vessel, ESP-Now satisfies almost all the requirements except for compatibility, which in the master-slave setup, only 1 node need to be wired to the raspberry pi.

## Network Visualization
[![Proa Local Server Network Framework](./images/Data%20Flow/Framework.png)](./images/Data%20Flow/)

Both Serial and ESP-NOW allows for bi-communication, allowing the raspberry pi to send command (zeroing, start, stop, etc.) to specific ESP32s (IMU), while the ESP32s sends data to the raspberry pi at the same time.

Although wireless communication is not as reliable as wired communication, where packet losss, sniffing, signal interference and range can affect the transmission, the data used is not critical for the operation. Additional measures such as encryption, error correction and data validation can be implemented to improve the reliability of the communication but is not fully / not implemented in this project.

[Template for communicating with the master node](./firmware/ESP32/template_sender_firmware//). Note that the mac address need to be changed to the master node's mac address in order for the ESP32 to send data to the master node.


# Technology Stack

ExpressJs backend with direct connection to the master ESP32 Node via Serial communication.

React frontend for real time data visualization and device control.

## Frontend & Backend Communication

- Access to the web application via the local network on port 4000.

- Real time console management in dev panel via WebSocket & xterm to the React frontend running on port 3001 for communication

- Data streaming from backend to frontend via a one-way Server Side Event (SSE) connection for real time data visualization.

- API endpoint for ad-hoc commands / data retrieval from the backend to the React frontend.

- API endpoint with middleware for authentication and authorization for device control and access to dev panel.

# Backend Structure

Backend structure is kept simple as this meant to mimic a control panel and data visualisation dashboard instead of a fullstack web application. Only basic security and authentication is implemented for the dev panel via middleware & JWT, while the rest of the backend is open to the local network.

## Folder Structure
- Handler folder for handling different data streams
    - Receiving raw bytes from the master ESP32 node, parsing it, before handing it to the appropriate handler for processing and storage in the database.
    - Handler for sending commands to the master ESP32 node via Serial communication.
    - Sync data with cloud database (Supabase - Currently disabled) when internet connection is available.
    - Transmit messages (status, errors, warnings) to the React frontend via SSE for real time visualization.
    - Receives command from dev panel from the frontend (connect to wifi, update repo, configure running mode, etc.) and execute it on the backend.
- Lib for custom functions
    - (Extended) Kalman filter implementation on Javascript
    - KCL Corrector algorithm
- Scripts folder for handling server management (Following npm commands require you to be in the backend folder)
    - Automatic building of frontend into backend for deployment (`npm run rebuild`)
    - Automatic restart of backend after pulling repo from github (`npm run start:all`)
    - Download map tiles for offline usage (`npm run download:map`)
    - Automatic zipping and unzipping map tiles when building / downloading
- Model folder pslit into 2 file for each table
    - {__}_models.js for defining the table structure and schema
    - {__}_db.js for defining the functions to interact with the table (CRUD operations)
    - Exception: Power management requires multiple table and initialization + high speed data streaming.
    - Write Lock implemented for handling frontend download of database while still writing to db using a queue.

## Steps to Add New Data Stream Handler
1. Create a new handler file in the handler > serial reader > components folder.
2. Use other handler as a template to parse, validate and queue bytes for processing and storage in the database.
3. Add to serialReader.js for the new handler to be called when receiving data from the master ESP32 node.
4. Add to the appropriate model for the new data stream to be stored in the database.
5. Add new api routes if needed for: session restore, config fetching, etc.
6. Add to lib if more complex data processing is needed (e.g. filtering, smoothing, etc.)

## Kalman Filter Implementation

Extended Kalman filter used in SoC estimation for the 2 battery bank system. The filter is implemented in Javascript and can be found in the lib folder. The filter is used to estimate the state of charge (SoC) of the battery bank based on the voltage and current measurements from the power management board.

3 filters are running simultaneously. 1 for each battery bank and 1 for the 4 Hall Effect current sensor to correct drifting using Kirchhoff's Current Law (KCL).

## Test Mode

Test mode is only implemented for power management sensor data stream. Setting test mode to true in .env or in the frontend dev panel will simulate the power management data from previous charging and discharge cycles. 

# Frontend Structure

React frontend with MUI dashboard [template](https://github.com/mui/material-ui/tree/v9.0.1/docs/data/material/getting-started/templates/dashboard).

Admin dashboard template used for data visualization and device control, with a dev panel for debugging and testing purposes (some config and mac address of microcontrollers transmited over api unencrypted as it is not a critical infrastructure).

- Each component resides in its own folder with "index.js" as the main entry point, and "styles.js" for styling. The components are organized into folders based on how they will be rendered (e.g. Dev Panel > Tabs > Database Tab > index.js).

- Server Side Event (SSE) for real time data streaming collected in "Dashboard.tsx" and passed down to the appropriate component for rendering (add more eventlisteners for different data sources).

## Steps to add new tabs:
1. Create the tab component in "components > MainBody".
2. Add on to the "mainContent" state in "Dashboard.tsx".
3. Add a new component to the main body.
4. Add to list item in "Sidebar/MenuContent.jsx" for the new tab to be rendered and selected in the sidebar.


## Dev panel control
- To access control of the ESP32 devices (strain / IMU), option will only be unlocked in the original tab after loging into the dev panel. 
- Internet: Connect to a Wi-Fi network (Does not work with some device hotspots due to mismatch of bandwidth of the device and external wifi adapter)
- Console: Direct access to the backend console for debugging and testing purposes.
- Server: Switch between Test and Normal mode, update the repo (requires internet connection), and restart the server.
- Database: View the database and export it to a CSV file for analysis.
- Logout: Logout


# Raspberry Pi 4 Setup 

## Part 1: Running the App

1. Copy .env-example to .env
2. `cd` into `PROA_LOCAL_SERVER_NETWORK`.
3. Ensure npm is installed on your system.
4. Run `npm run install:yarn`.
5. Run `npm run rebuild`.
6. Run `npm run start:all`.
   - This automatically builds the React app and runs it with Node.js.
7. Open `http://localhost:4000` in your browser.
8. Dev panel access: username=admin   password=admin

---

## Part 2: Raspberry Pi 4 Setup (Everything else after this is for setting up on raspberry pi)

Using Raspberry Pi Lite OS for fast boot time in case of downtime.
> A UPS is included, but fast boot time and proper recovery steps are still essential.

### 2.1 Initial Setup (from a fresh install via Raspberry Pi Imager)

If ssh does not work, you may need to connect the Pi to an external screen and keyboard to enable it.
1. Connect the Pi to an external screen (micro HDMI) and keyboard.
2. Log in with the username and password created during Imager setup.
3. Enable and start SSH:
   ```bash
   sudo systemctl enable ssh
   sudo systemctl start ssh
   ```

### 2.2 SSH into the Pi from Another Computer

1. On Raspberry Pi 4 and below (check your model first), the USB-C port is power-only — you'll need an additional Ethernet cable to connect.

### 2.3 Optimize Boot Time

1. Open the quick system settings GUI to connect to a WiFi network for update purposes:
   ```bash
   sudo raspi-config
   ```
2. Disable unneeded services for a faster boot:
   ```bash
   sudo systemctl disable NetworkManager-wait-online.service
   sudo systemctl mask NetworkManager-wait-online.service
   sudo systemctl disable cloud-init-local.service
   sudo systemctl disable cloud-init-main.service
   sudo systemctl disable cloud-config.service
   sudo systemctl disable cloud-final.service
   sudo systemctl disable apt-daily-upgrade.service
   sudo systemctl disable apt-daily.service
   ```
3. Note: boot time will still be around 20 seconds.

### 2.4 Verify Network Connectivity (Before Upgrading Packages)
 
`apt full-upgrade` requires a working internet connection — check this first if you hit connection errors.
 
1. Check if Wi-Fi is scanning networks:
```bash
   sudo iwlist wlan0 scan | grep ESSID
```
2. If nothing comes back (Wi-Fi is down), bring it back up:
```bash
   sudo rfkill unblock wifi
   sudo ip link set wlan0 up
   sudo nmcli radio wifi on
   sudo systemctl restart wpa_supplicant
   sudo systemctl restart NetworkManager
```
3. Re-run the scan command from step 1 to confirm networks now appear, then proceed.

### 2.5 Download Required Packages

1. Update and install system packages:
   ```bash
   sudo apt full-upgrade
   sudo apt install git nodejs npm curl hostapd dnsmasq dhcpcd5 iptables nginx -y
   sudo npm install yarn -g
   ```
2. Install nvm and Node LTS:
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   source ~/.bashrc
   nvm install --lts
   nvm use node
   ```

### 2.6 Set Up the Git Repo

1. Create a directory and clone the repo:
   ```bash
   mkdir apps
   cd apps
   git clone https://github.com/Inverated/Proa_Local_Server_Network advisor
   cd advisor/
   yarn install
   yarn start:all
   ```
2. Force-stop the process once the initial build completes.

3. Copy '.env' into proa_advisor

### 2.7 Set Up the Network (Wi-Fi Access Point)

1. Stop the AP-related services before configuring them:
   ```bash
   sudo systemctl stop hostapd
   sudo systemctl stop dnsmasq
   ```
2. Mark `wlan0` as unmanaged by NetworkManager. Edit:
   ```bash
   sudo nano /etc/NetworkManager/conf.d/unmanaged.conf
   ```
   Add:
   ```ini
   [keyfile]
   unmanaged-devices=interface-name:wlan0
   ```
3. Set a static IP for `wlan0`. Edit:
   ```bash
   sudo nano /etc/dhcpcd.conf
   ```
   Add:
   ```ini
   interface wlan0
   static ip_address=192.168.4.1/24
   nohook wpa_supplicant
   ```
4. Restart the dhcpcd service:
   ```bash
   sudo systemctl restart dhcpcd
   ```
5. Configure hostapd. Edit:
   ```bash
   sudo nano /etc/hostapd/hostapd.conf
   ```
   Add:
   ```ini
   interface=wlan0
   driver=nl80211

   ssid=Proa_II

   hw_mode=g
   channel=6

   country_code=SG

   wmm_enabled=1

   auth_algs=1
   ignore_broadcast_ssid=0

   wpa=2
   wpa_passphrase=password

   wpa_key_mgmt=WPA-PSK
   rsn_pairwise=CCMP
   ```
6. Point the hostapd daemon at that config. Edit:
   ```bash
   sudo nano /etc/default/hostapd
   ```
   Add:
   ```ini
   DAEMON_CONF="/etc/hostapd/hostapd.conf"
   ```
7. Back up and replace the dnsmasq config:
   ```bash
   sudo mv /etc/dnsmasq.conf /etc/dnsmasq.conf.orig
   sudo nano /etc/dnsmasq.conf
   ```
   Add:
   ```ini
   interface=wlan0

   dhcp-range=192.168.4.2,192.168.4.100,255.255.255.0,24h

   dhcp-option=3,192.168.4.1
   dhcp-option=6,192.168.4.1

   address=/#/192.168.4.1
   ```
8. Unmask and enable the AP services, then restart networking and start them:
   ```bash
   sudo systemctl unmask hostapd
   sudo systemctl enable hostapd
   sudo systemctl enable dnsmasq

   sudo systemctl restart wpa_supplicant
   sudo systemctl restart NetworkManager
   sudo systemctl start hostapd
   sudo systemctl start dnsmasq
   ```
9. Verify `wlan0` is running in AP mode:
    ```bash
    iw dev wlan0 info
    ```
    If the type isn't `AP`, run `sudo reboot` and check again.

10. Give access to user to run nmcli over Node
    ```bash
    sudo nano /etc/polkit-1/rules.d/50-nmcli.rules
    ```
    Add:
    ```javascript
    polkit.addRule(function(action, subject) {
        if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 &&
            subject.user == "admin") {
            return polkit.Result.YES;
        }
    });
    ```
11. Restart polkit:
    ```bash
    sudo systemctl restart polkit
    ```


### 2.9 Auto-Redirect Port 80 to the App (Port 4000)

1. Create the redirect service:
   ```bash
   sudo nano /etc/nginx/sites-available/solarproa
   ```
   Add:
   ```ini
   server {
    listen 80;
    server_name solarproa.local;

    location / {
        proxy_pass http://127.0.0.1:4000;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
   }
   ```
2. Enable and start it:
   ```bash
   sudo ln -s /etc/nginx/sites-available/solarproa /etc/nginx/sites-enabled/
   ```

3. Test it:
   ```bash
   sudo nginx -t
   ```

4. Restart nginx service
   ```bash
   sudo systemctl restart nginx
   ```

   When connected to the same network as the raspberry pi, go to http://solarproa.local

### 2.8 Set Up Auto-Start on Boot

1. Create the app service:
   ```bash
   sudo nano /etc/systemd/system/solarproa-advisor.service
   ```
   Add:
   ```ini
    [Unit]
    Description=Solar Proa Advisor
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    User=admin
    WorkingDirectory=/home/admin/apps/advisor/proa_advisor

    Environment=NODE_ENV=production
    Environment=NVM_DIR=/home/admin/.nvm

    ExecStart=/bin/bash -c 'source "$NVM_DIR/nvm.sh" && nvm use default && exec yarn start'

    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
   ```
2. Enable and start it:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable solarproa-advisor
   sudo systemctl start solarproa-advisor
   ```
3. Check the logs:
   ```bash
   journalctl -u solarproa-advisor -f
   ```

### 2.10 Note: AP vs. Wi-Fi Receiver Mode

The Wi-Fi chip can only act as **either** an access point **or** a receiver at one time — switch back to receiving, or use an external Wi-Fi adapter.

1. Check the new Wi-Fi receiver's interface name (should be `wlan1`).
2. Connect to a network on that interface:
   ```bash
   sudo nmcli device wifi connect "YourSSID" password "YourPassword" ifname wlan1
   ```

# Final Notes

- While raspberry pi 4 is used as the server, the setup can be ran on any windows / linux machine, as long as the master esp32 node can be physically connected to the machine
- A stronger computer / mini pc can be used to run the server instead for a larger vessel where more users are expected to connect to the server at the same time, or for a more complex system with more sensors and data streams and AI processing or sailing / electrical "expert" trained model can be implemented to provide real time feedback and control of the vessel.
- For production use / future development, proper security measures, such as ESP-now encryption, encrypted data (on top of current JWT authentication), and secure communication protocols (HTTPS, WSS) should be implemented to protect the system from potential attacks and unauthorized access.
- As more sensor data is added, proper routing and folder sturcture should be implemented. Currently, all api end points are dumped into index.js as there is not a lot yet. 
- Test mode is currently limited to power management data stream but should be extended to other data stream as data will be collected into the db and be downloadable for future testing.